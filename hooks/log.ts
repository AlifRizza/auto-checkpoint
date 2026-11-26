export type Level = 'none' | 'task' | 'decide' | 'must' | 'force'
export type Levels = { taskCheckAt: number; decideAt: number; mustAt: number; forceAt: number }
export type Checkpoint = {
  goal: string
  status: string
  next_step: string
  decisions: string[]
  results: string[]
  open: string[]
}

export const DEFAULT_LEVELS: Levels = { taskCheckAt: 400_000, decideAt: 600_000, mustAt: 850_000, forceAt: 900_000 }
export const MIN_LEVEL = 20_000
export const RANK: Record<Level, number> = { none: 0, task: 1, decide: 2, must: 3, force: 4 }
export const LOG_FILE = 'PROJECT_LOG.md'

/** The four levels from the settings; one unusable value, or any out of rising order, puts all back to the defaults. */
export function parseLevels(options: Record<string, unknown>): Levels {
  const keys = ['taskCheckAt', 'decideAt', 'mustAt', 'forceAt'] as const
  const values = keys.map(k => Number(options[k] ?? DEFAULT_LEVELS[k]))
  const isUsable = values.every((n, i) => Number.isFinite(n) && n >= MIN_LEVEL && (i === 0 || n > (values.at(i - 1) ?? 0)))
  if (!isUsable) return DEFAULT_LEVELS
  const [taskCheckAt = 0, decideAt = 0, mustAt = 0, forceAt = 0] = values.map(Math.floor)

  return { taskCheckAt, decideAt, mustAt, forceAt }
}

/**
 * The levels assume a 1M window. On a smaller one (a 200k model) they scale with it, so a forced checkpoint still
 * comes before the window fills: built-in auto-compact is off, and nothing else would stop it.
 */
export function fitLevels(levels: Levels, window: number | undefined): Levels {
  if (window === undefined || window * 0.9 >= levels.forceAt) return levels
  // Scale to the levels' own forceAt, so levels set for a small window are not shrunk as if set for 1M.
  const scale = (window * 0.9) / levels.forceAt

  return {
    taskCheckAt: Math.round(levels.taskCheckAt * scale),
    decideAt: Math.round(levels.decideAt * scale),
    mustAt: Math.round(levels.mustAt * scale),
    forceAt: Math.round(levels.forceAt * scale),
  }
}

/**
 * Levels set below what a compaction leaves (the summary, the system prompt, the tools) would fire on every turn
 * after it. They move up by that floor, spacing kept, so each checkpoint still comes after the same amount of new
 * work; never past 90% of the window. Levels already above the floor stay as set.
 */
export function liftLevels(levels: Levels, floor: number, window: number): Levels {
  if (levels.taskCheckAt > floor) return levels
  const by = Math.min(floor, window * 0.9 - levels.forceAt)
  if (by <= 0) return levels

  return {
    taskCheckAt: levels.taskCheckAt + by,
    decideAt: levels.decideAt + by,
    mustAt: levels.mustAt + by,
    forceAt: levels.forceAt + by,
  }
}

export function levelOf(tokens: number | undefined, levels: Levels): Level {
  if (tokens === undefined || tokens < levels.taskCheckAt) return 'none'
  if (tokens < levels.decideAt) return 'task'
  if (tokens < levels.mustAt) return 'decide'

  return tokens < levels.forceAt ? 'must' : 'force'
}

const k = (tokens: number) => `${Math.max(0, Math.round(tokens / 1000))}k`

/**
 * What Claude is told at a level, word for word as the spec fixes it; nothing below taskCheckAt.
 * The size guide's numbers are for a 1M window and scale with a smaller one, as the levels do.
 */
export function noteFor(level: Level, tokens: number, levels: Levels, window = 1_000_000): string | undefined {
  if (level === 'none') return undefined
  const room = k(levels.forceAt - tokens)
  const size = (n: number) => k(Math.max(1000, n * Math.min(1, window / 1_000_000)))
  const task = [
    `Context: ${k(tokens)} tokens used, ${room} before a forced checkpoint.`,
    "If the user's latest message starts a new task, estimate the tokens it needs before any tool call.",
    `Rough guide: one large file read ${size(5000).slice(0, -1)}-${size(20_000)}; a change across several files ${size(100_000).slice(0, -1)}-${size(200_000)}; a long debugging session ${size(200_000)} or more.`,
    `If it fits in ${room}, start. If not, do not start: give your estimate and the room left, and suggest a checkpoint first.`,
    'If the user agrees, call checkpoint with this task as next_step.',
  ]
  const decide = [
    'At the end of each sub-task, decide whether the next sub-task can be done well after a compaction, with only PROJECT_LOG.md and the summary.',
    'Safe: call checkpoint, then end your turn. Not safe (detail that lives only in this context, a change half done across files): keep working and decide again at the next boundary.',
    'Never stop in the middle of a sub-task to checkpoint.',
  ]
  const must = [
    `The mod forces a checkpoint at ${k(levels.forceAt)}. Checkpoint at the very next sub-task boundary, even if a later one would be cleaner.`,
    'Put any detail that lives only in this context into decisions or open.',
  ]
  const lines = level === 'task' ? task : level === 'decide' ? [...task, ...decide] : [...task, ...must]

  return lines.join('\n')
}

/** The tool's arguments as a Checkpoint, or the error the model reads. */
export function parseCheckpoint(input: unknown): Checkpoint | string {
  const args = (input ?? {}) as Record<string, unknown>
  const missing = (['goal', 'status', 'next_step'] as const).filter(
    key => typeof args[key] !== 'string' || (args[key] as string).trim() === '',
  )
  if (missing.length > 0) return `checkpoint needs non-empty: ${missing.join(', ')}`

  const lists: Record<string, string[]> = {}
  for (const key of ['decisions', 'results', 'open'] as const) {
    const value = args[key] ?? []
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
      return `checkpoint: ${key} must be a list of strings`
    }
    lists[key] = value.map(item => item.trim()).filter(item => item !== '')
  }

  return {
    goal: (args.goal as string).trim(),
    status: (args.status as string).trim(),
    next_step: (args.next_step as string).trim(),
    decisions: lists.decisions ?? [],
    results: lists.results ?? [],
    open: lists.open ?? [],
  }
}

const SEKARANG = '## Sekarang'
const LOG = '## Log'
// Marks a log this mod wrote: only such a file's Sekarang is sent to Claude, so a cloned repo's file is not.
const MARK = '<!-- auto-checkpoint -->'
// Past this the oldest Log entries move to an archive file: $.fs.read rejects past 4 MiB.
export const MAX_LOG = 1_048_576

function section(label: string, items: readonly string[]): string[] {
  return items.length === 0 ? [] : [`**${label}:**`, ...items.map(item => `- ${item}`)]
}

/**
 * The new file: Sekarang rewritten from the checkpoint, every earlier Log entry kept, the new entry last.
 * Your own text above Log (a title, a preamble, sections of your own) stays where it was.
 * A file with no Log section (written by hand) is kept whole as the first entry, "Earlier notes".
 */
export function writeLog(existing: string, cp: Checkpoint, stamp: string): string {
  const at = existing.indexOf(`\n${LOG}\n`)
  let earlier = ''
  let top = '# PROJECT_LOG'
  let own = ''
  if (at >= 0) {
    earlier = existing.slice(at + LOG.length + 2).trim()
    const above = existing.slice(0, at)
    const start = above.indexOf(`${SEKARANG}\n`)
    const rest = start < 0 ? '' : above.slice(start + SEKARANG.length + 1)
    const end = rest.search(/^## /m)
    top = (start < 0 ? above : above.slice(0, start)).replace(MARK, '').trim() || top
    own = end < 0 ? '' : rest.slice(end).trim()
  } else if (existing.trim() !== '') earlier = `### Earlier notes\n${existing.trim()}`

  return [
    top,
    MARK,
    '',
    SEKARANG,
    `**Goal:** ${cp.goal}`,
    `**Status:** ${cp.status}`,
    `**Next step:** ${cp.next_step}`,
    '',
    ...(own === '' ? [] : [own, '']),
    LOG,
    '',
    ...(earlier === '' ? [] : [earlier, '']),
    entryOf(cp, stamp),
    '',
  ].join('\n')
}

/** One Log entry: its stamp, then decisions, results and open. */
export function entryOf(cp: Checkpoint, stamp: string): string {
  return [`### ${stamp}`, ...section('Decisions', cp.decisions), ...section('Results', cp.results), ...section('Open', cp.open)].join('\n')
}

/** The Sekarang section's lines, or undefined when the file has none or the mod did not write it. */
export function sekarangOf(log: string): string | undefined {
  const start = log.indexOf(`${SEKARANG}\n`)
  if (start < 0 || !log.slice(0, start).includes(MARK)) return undefined
  const body = log.slice(start + SEKARANG.length + 1)
  const end = body.search(/^## /m)
  const text = (end < 0 ? body : body.slice(0, end)).trim()

  return text === '' ? undefined : text
}

/**
 * A log past MAX_LOG split in two: the log with its newest Log entries (Sekarang and your text kept), and the
 * oldest entries for the archive. Under the limit, the log whole and an empty archive.
 */
export function splitArchive(text: string): { log: string; archive: string } {
  const at = text.indexOf(`\n${LOG}\n`)
  if (text.length <= MAX_LOG || at < 0) return { log: text, archive: '' }
  const head = text.slice(0, at + LOG.length + 2)
  const entries = text.slice(head.length).split(/\n(?=### )/)
  // Newest first, up to half the limit; the newest entry always stays.
  let cut = entries.length
  let size = head.length
  while (cut > 0 && (cut === entries.length || size + (entries[cut - 1] ?? '').length + 1 <= MAX_LOG / 2)) {
    size += (entries[cut - 1] ?? '').length + 1
    cut--
  }
  const kept = entries.slice(cut)
  const archive = entries.slice(0, cut).join('\n').trim()

  return { log: `${head}${kept.join('\n').replace(/^\n*/, '\n')}`, archive: archive === '' ? '' : `${archive}\n` }
}

/** The context block a new conversation (and every compaction) carries. */
export function projectLogBlock(sekarang: string): string {
  return `## Project log\n${sekarang}\nFull history is under Log in ${LOG_FILE}. Open it only when you need past decisions.`
}

export function logPath(root: string): string {
  return `${root.replace(/\/+$/, '')}/${LOG_FILE}`
}

/** A Log entry's heading: minutes, UTC, so it reads the same on every machine. */
export function stampOf(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

export function resumePrompt(docs: number): string {
  const graph =
    docs > 0
      ? `First run /graphify --update: ${docs} document${docs === 1 ? '' : 's'} changed since the graph was built.\n`
      : ''

  return `${graph}Resumed after a checkpoint. If your last answer before it asked the user a question, wait for their reply. Otherwise carry on from Next step in the project log, without waiting for the user.`
}

export const COMPACT_INSTRUCTIONS = `A checkpoint was just saved to ${LOG_FILE}. Keep its Sekarang section (Goal, Status, Next step) word for word, and keep what the next step needs: file paths, commands and exact error messages, and any question your last answer asked the user. Drop detail of finished work.`

export const ASK_PROMPT =
  'The user asked for a checkpoint. At your next safe sub-task boundary, call checkpoint, then end your turn. If you are between sub-tasks now, call it now.'

export const CHECKPOINT_TOOL = {
  name: 'checkpoint',
  description: `Save a checkpoint of this project to ${LOG_FILE}; the mod then compacts the conversation and resumes from next_step with no prompt from the user. Call it only when a context note from the mod asks for one, at a sub-task boundary where the next sub-task can be done well from the log alone, or when the user asked or agreed to checkpoint. A finished step or a pause for the user's decision is not by itself a reason to checkpoint. Make it your last tool call, also inside a script: after a successful call, end your turn.`,
  isDeferred: false,
  inputSchema: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: "What the user is trying to achieve, in the user's words where possible." },
      status: { type: 'string', description: 'What is done and verified so far.' },
      next_step: { type: 'string', description: 'The one concrete action to take next, specific enough to start at once.' },
      decisions: { type: 'array', items: { type: 'string' }, description: 'Choices made since the last checkpoint, with the reason.' },
      results: { type: 'array', items: { type: 'string' }, description: 'Outcomes since the last checkpoint: numbers, files, passing tests.' },
      open: { type: 'array', items: { type: 'string' }, description: 'Unresolved problems, with exact error text; may be empty.' },
    },
    required: ['goal', 'status', 'next_step'],
  },
}

export const FORCE_PROMPT = `The context is nearly full and the conversation will be compacted now. Write a checkpoint of where the work stands.
Reply with one JSON object only, no other text:
{"goal": string, "status": string, "next_step": string, "decisions": string[], "results": string[], "open": string[]}
goal: what the user is trying to achieve. status: what is done and verified. next_step: the one concrete action to take next.
decisions, results, open: since the last checkpoint; put any detail that lives only in this conversation into decisions or open.`

/** A forced checkpoint's reply as a Checkpoint: the first {...} in it, fenced or not; undefined when unusable. */
export function parseForced(text: string): Checkpoint | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const parsed = parseCheckpoint(JSON.parse(text.slice(start, end + 1)))
    return typeof parsed === 'string' ? undefined : parsed
  } catch {
    return undefined
  }
}

/** Prints how many documents and papers changed since the graph was built: graphify's own detector, read-only. */
export const DOC_COUNT_SCRIPT = `from pathlib import Path
from graphify.detect import detect_incremental
r = detect_incremental(Path('.'), kind='semantic')
print(len(r['new_files'].get('document', [])) + len(r['new_files'].get('paper', [])))`

/** The count DOC_COUNT_SCRIPT printed on its last line; anything else is 0. */
export function parseDocCount(stdout: string): number {
  const n = Number(stdout.trim().split('\n').pop())

  return Number.isInteger(n) && n > 0 ? n : 0
}
