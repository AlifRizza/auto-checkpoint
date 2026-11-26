import type { EngineInterface, Register } from 'claude-code'

import type { Owed } from '../types'

import {
  ASK_PROMPT,
  CHECKPOINT_TOOL,
  COMPACT_INSTRUCTIONS,
  DOC_COUNT_SCRIPT,
  FORCE_PROMPT,
  fitLevels,
  type Checkpoint,
  type Level,
  type Levels,
  entryOf,
  levelOf,
  liftLevels,
  logPath,
  noteFor,
  parseCheckpoint,
  parseDocCount,
  parseForced,
  parseLevels,
  projectLogBlock,
  RANK,
  resumePrompt,
  sekarangOf,
  splitArchive,
  stampOf,
  writeLog,
} from './log'

const TOOL = 'mcp__auto-checkpoint__checkpoint'
const OWED = { plugin: 'auto-checkpoint', key: 'owed' } as const

// Module state: reset when the module reloads. What a reload must not forget is mirrored to $.state (OWED).
let levels: Levels
let isGraphRefresh = true
// Set when the four level settings were unusable and fell back to the defaults: told once at session.start.
let isLevelsFallback = false
// A checkpoint is saved and the compaction is owed at the next clean turn end.
let isDue = false
// The checkpoint was made in the turn still running: any later tool batch in it makes the log stale.
let isFreshThisTurn = false
// The tool batch holding the checkpoint call has not ended yet (in Code Mode, the whole script is that batch).
let isCheckpointBatch = false
let isCompacting = false
// Cleared when you send a prompt while a compaction is owed: your message is what Claude works on next.
let isResumeWanted = true
// You typed while the running turn worked: a checkpoint in it must not resume over your message.
let isTypedThisTurn = false
// You asked for a checkpoint (/save-checkpoint, or "checkpoint" in your message): allowed below the levels until saved.
let isAsked = false
// A compaction was vetoed: no forced checkpoint again until the context is back under forceAt.
let isVetoed = false
// The highest level whose note Claude has read since the last compaction.
let noted: Level = 'none'
// Tokens the last compaction left, measured at the first turn end after it; levels below it move up by it.
let floor = 0
// A compaction just ran: the next main-loop turn end measures the floor, and checks nothing else.
let isFloorDue = false
// Background tasks in flight at this turn's Stop; cleared at every turn end, so an old count never holds one.
let background = 0
let isWaitingToasted = false

/** Tokens used now, the levels fitted to this session's window and lifted over the floor, and the window. */
async function usageOf($: EngineInterface): Promise<{ tokens: number; fitted: Levels; window: number }> {
  const { context } = await $.session.usage()
  const window = context.window ?? 1_000_000

  return { tokens: context.tokens ?? 0, fitted: liftLevels(fitLevels(levels, window), floor, window), window }
}

/**
 * Sets built-in Auto-compact to `isOn` when it is not already, and says so. A /config change of the mod's options
 * reloads it and runs session.start again, so flipping the mod's own switch flips Auto-compact with it.
 */
async function syncAutoCompact($: EngineInterface, isOn: boolean): Promise<void> {
  const rows = await $.config.list().catch(() => [])
  const row = rows.find(r => r.key === 'autoCompact')
  if (row === undefined || row.value === isOn) return
  const { deny } = await $.config.set({ key: 'autoCompact', value: isOn }).catch((error: unknown) => ({ deny: String(error) }))
  $.ui.toast(
    deny === undefined
      ? `auto-checkpoint: ${isOn ? 'off; built-in Auto-compact turned back on.' : 'on; built-in Auto-compact turned off.'}`
      : `auto-checkpoint: could not turn built-in Auto-compact ${isOn ? 'on' : 'off'} (${deny}); set it in /config.`,
  )
}

/** Mirrors the owed-compaction marks to $.state, which a hot reload keeps; the module's variables start over. */
async function keepOwed($: EngineInterface): Promise<void> {
  const owed: Owed = { isDue, isResumeWanted, isVetoed, floor, isFloorDue }
  await $.state.set(OWED, owed).catch(() => undefined)
}

async function isPast($: EngineInterface, level: keyof Levels): Promise<boolean> {
  const { tokens, fitted } = await usageOf($)

  return tokens >= fitted[level]
}

/**
 * Writes the checkpoint and reads it back; the path once the file holds the entry, else undefined. A read-back
 * that differs means another session wrote meanwhile: the entry goes onto that version, so neither entry is lost.
 * Past MAX_LOG the oldest entries move to a new archive file first; nothing is deleted.
 * shortcut: no lock (the API has none): another session's write that lands after this read-back, built on a file it
 * read before this write, still drops this entry; add a lock file if two sessions often share one project folder.
 */
async function save($: EngineInterface, cp: Checkpoint): Promise<string | undefined> {
  const root = (await $.session.root()).replace(/\/+$/, '')
  const path = logPath(root)
  const now = await $.clock.now()
  const entry = entryOf(cp, stampOf(now))
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
    // The other session built its file on ours, so it already holds the entry: done.
    if (attempt > 0 && existing.includes(entry)) return path
    const { log, archive } = splitArchive(writeLog(existing, cp, stampOf(now)))
    if (archive !== '') {
      await $.fs.write(`${root}/PROJECT_LOG.archive-${now}${attempt === 0 ? '' : `-${attempt}`}.md`, `# PROJECT_LOG archive\n\n${archive}`)
    }
    await $.fs.write(path, log)
    if ((await $.fs.read(path)) === log) {
      if (attempt > 0) $.ui.toast('auto-checkpoint: another session wrote PROJECT_LOG.md meanwhile; both entries kept.')
      return path
    }
  }

  return undefined
}

/**
 * Only where the project has a graphify graph: count the changed docs first (the update clears the record the
 * count reads), then re-extract code. Returns the doc count; never throws, since the graph must not block compaction.
 */
async function refreshGraph($: EngineInterface): Promise<number> {
  const root = await $.session.root()
  if (!(await $.fs.exists(`${root}/graphify-out/graph.json`))) return 0
  $.ui.toast('auto-checkpoint: refreshing the graphify graph…')

  let docs = 0
  try {
    // The path comes from a file in the repo: run only an interpreter outside the project, -P keeps the project off sys.path.
    const python = (await $.fs.read(`${root}/graphify-out/.graphify_python`)).trim()
    if (python.startsWith('/') && !python.startsWith(`${root}/`)) {
      const counted = await $.process.run([python, '-P', '-c', DOC_COUNT_SCRIPT], { cwd: root, timeoutMs: 60_000 })
      if (counted.exitCode === 0) docs = parseDocCount(counted.stdout)
    }
  } catch (error) {
    $.ui.toast(`auto-checkpoint: could not count changed docs: ${String(error)}`)
  }
  try {
    const updated = await $.process.run(['graphify', 'update', root], { cwd: root, timeoutMs: 300_000 })
    if (updated.exitCode !== 0) $.ui.toast(`auto-checkpoint: graphify update ended with exit ${updated.exitCode}; compacting anyway.`)
  } catch (error) {
    $.ui.toast(`auto-checkpoint: graphify update did not run (${String(error)}); compacting anyway.`)
  }

  return docs
}

/** Graph refresh, compaction, resume. Runs from a timer: $.session.compact rejects while a turn runs. */
async function compactNow($: EngineInterface): Promise<void> {
  try {
    const docs = isGraphRefresh ? await refreshGraph($) : 0
    const compacted = await $.session.compact({ instructions: COMPACT_INSTRUCTIONS })
    isDue = false
    if (compacted.skip !== undefined) {
      isVetoed = true
      await keepOwed($)
      $.ui.toast(`auto-checkpoint: compaction skipped: ${compacted.skip}`)
      return
    }
    noted = 'none'
    // Until the next turn end measures what this compaction left, no level fires: the usage is still the old one.
    floor = 0
    isFloorDue = true
    await keepOwed($)
    if (isResumeWanted) await $.prompt.submit({ text: resumePrompt(docs) })
  } catch (error) {
    // A turn started first (you typed): the compaction stays owed and runs at that turn's end.
    $.ui.toast(`auto-checkpoint: compaction postponed (${String(error)}).`)
  } finally {
    isCompacting = false
  }
}

/** Past forceAt with no checkpoint: the mod writes one itself, and compacts even when it cannot. */
async function forceCheckpoint($: EngineInterface): Promise<void> {
  const reply = await $.model.fork({ prompt: FORCE_PROMPT }).catch(() => undefined)
  const cp = reply?.isAnswered === true ? parseForced(reply.text) : undefined
  const path = cp === undefined ? undefined : await save($, cp).catch(() => undefined)
  if (path === undefined) $.ui.toast('auto-checkpoint: forced compaction; the project log was not updated, so Claude waits for you.')
  // Owed until it runs: a postponed compaction must not fork and write the log again.
  isDue = true
  // Next step in an old log is stale: resume only from the checkpoint just written.
  isResumeWanted = path !== undefined
  await keepOwed($)
  await compactNow($)
}

export const register: Register = (on, options) => {
  // Off in /config: session.start turns built-in Auto-compact back on, and no other hook is registered.
  const isEnabled = options.enabled !== false
  levels = parseLevels(options)
  const keys = ['taskCheckAt', 'decideAt', 'mustAt', 'forceAt'] as const
  isLevelsFallback = keys.some(key => options[key] !== undefined && Number(options[key]) !== levels[key])
  isGraphRefresh = options.graphRefresh !== false
  isDue = false
  isFreshThisTurn = false
  isCheckpointBatch = false
  isCompacting = false
  isResumeWanted = true
  isTypedThisTurn = false
  isAsked = false
  isVetoed = false
  noted = 'none'
  floor = 0
  isFloorDue = false
  background = 0
  isWaitingToasted = false

  on('session.start', async ($, e, next) => {
    // On: built-in Auto-compact off, or it compacts mid-task before Claude decides. Off: back on.
    await syncAutoCompact($, !isEnabled)
    if (!isEnabled) return next(e)
    // The tool first: a refused command name must not cost Claude its checkpoint tool.
    await $.tool.register(CHECKPOINT_TOOL)
    await $.command.register({ name: 'save-checkpoint', description: 'Ask Claude to checkpoint at its next safe boundary' })
    // A reload runs this again: take back an owed compaction the module's variables forgot.
    const { value: owed } = await $.state.get(OWED).catch(() => ({ value: undefined }))
    if (owed !== undefined) ({ isDue, isResumeWanted, isVetoed, floor = 0, isFloorDue = false } = owed)
    if (isLevelsFallback) {
      $.ui.toast('auto-checkpoint: the four levels must each be 20000 or more and rise in order; levels fell back to the defaults.')
    }

    return next(e)
  })
  if (!isEnabled) return

  on('command.run', { command: 'save-checkpoint' }, $ => {
    isAsked = true
    // $.prompt.submit waits for the turn this command is part of: send it after this dispatch.
    $.clock.after(0, () => void $.prompt.submit({ text: ASK_PROMPT }))
    return { text: 'Asked Claude to checkpoint at its next safe boundary.' }
  })

  // Sent once per conversation and again after every compaction, so it costs no cache.
  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    const path = logPath(await $.session.root())
    const sekarang = (await $.fs.exists(path)) ? sekarangOf(await $.fs.read(path)) : undefined
    if (sekarang === undefined) return result

    return { ...result, blocks: [...result.blocks, { name: 'projectLog', text: projectLogBlock(sekarang) }] }
  })

  // The level note rides as hidden context on the prompt, never in the system prompt.
  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined) return next(e)
    // A background task's notification is not you: it must not stop the resume.
    const isUser = e.origin.kind !== 'plugin' && e.origin.kind !== 'task-notification'
    if (isUser && /checkpoint/i.test(e.text)) isAsked = true
    if (isUser && isDue && isResumeWanted) {
      isResumeWanted = false
      await keepOwed($)
    }
    if (isUser && e.turnId !== undefined) isTypedThisTurn = true

    if (isFloorDue) return next(e)
    const { tokens, fitted, window } = await usageOf($)
    const level = levelOf(tokens, fitted)
    const note = noteFor(level, tokens, fitted, window)
    if (note === undefined) return next(e)
    if (RANK[level] > RANK[noted]) noted = level

    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  // Answered at tool.call, ahead of the permission check, so no dialog stalls an unattended checkpoint.
  on('tool.call', { tool: TOOL }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: 'Only the main conversation can checkpoint.' }
    const { tool: _tool, tool_use_id: _id, agentId: _agent, requestMeta: _meta, ...args } = e as Record<string, unknown>
    const cp = parseCheckpoint(args)
    if (typeof cp === 'string') return { deny: cp }
    // Below the new-task level no note asked for one, so a compaction there only throws away context.
    const { tokens, fitted } = await usageOf($)
    if (tokens < fitted.taskCheckAt && !isAsked) {
      const k = (n: number) => `${Math.round(n / 1000)}k`
      return {
        deny: `Not needed yet: ${k(tokens)} used, and the mod asks for checkpoints from ${k(fitted.taskCheckAt)}. Below that, checkpoint only when the user asks (/save-checkpoint). Carry on without one.`,
      }
    }

    const path = await save($, cp).catch((error: unknown) => String(error))
    if (path === undefined || !path.startsWith('/')) {
      return { deny: `Could not save the checkpoint (${path ?? 'the file read back differently'}); nothing will be compacted. Carry on.` }
    }
    isDue = true
    isFreshThisTurn = true
    isCheckpointBatch = true
    isResumeWanted = !isTypedThisTurn
    isWaitingToasted = false
    isAsked = false
    await keepOwed($)

    return { result: `Saved to ${path}. End your turn now; the mod compacts the conversation and resumes from next_step.` }
  })

  // Watches after each tool batch instead of wrapping tools: a tool.run hook on every tool would turn off
  // Code Mode's wait for a stopped result. A Code Mode script is one batch, so the mod cannot see order inside it.
  // limit: an organization-managed install skips classic.* hooks; then no mid-turn notes and no stale check.
  on('classic.PostToolBatch', async ($, e, next) => {
    const result = await next(e)
    if (e.agent_id !== undefined) return result
    if (isCheckpointBatch) isCheckpointBatch = false
    else if (isFreshThisTurn && isDue) {
      isDue = false
      isFreshThisTurn = false
      await keepOwed($)
      $.ui.toast('auto-checkpoint: checkpoint dropped, work went on after it; Claude will checkpoint again.')
    }

    // A level crossed mid-turn: its note rides once after this batch.
    if (isFloorDue) return result
    const { tokens, fitted, window } = await usageOf($)
    const level = levelOf(tokens, fitted)
    if (RANK[level] <= RANK[noted] || RANK[level] < RANK.decide) return result
    noted = level

    return { ...result, additionalContext: [...(result.additionalContext ?? []), noteFor(level, tokens, fitted, window) ?? ''] }
  })

  // Notes background work still running (shells, agents, monitors) for the coming turn end. The types do not fix
  // whether Stop runs before turn.complete; the count is cleared at every turn end, so it is never an old turn's.
  // limit: an organization-managed install skips classic.* hooks; then background work is not waited for.
  on('classic.Stop', async ($, e, next) => {
    background = e.background_tasks?.length ?? 0

    return next(e)
  })

  // At the end of a main-loop turn, never mid-generation: a clean answer, or past mustAt an API error.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    const held = background
    background = 0
    isTypedThisTurn = false
    // An interrupted turn: the checkpoint's batch is over, so the next turn's first batch must not drop it.
    if (e.isAborted) {
      isFreshThisTurn = false
      isCheckpointBatch = false
      return result
    }
    // A turn the context limit killed ends on 'error': past mustAt, compact now; a clean end may never come.
    if (e.reason === 'error' ? !isDue && !(await isPast($, 'mustAt')) : e.reason !== 'answer') return result
    isFreshThisTurn = false
    isCheckpointBatch = false
    if (isCompacting) return result
    // The first turn end after a compaction: what is in the window now is what every later turn starts from.
    if (isFloorDue && !isDue) {
      const { tokens, window } = await usageOf($)
      const fitted = fitLevels(levels, window)
      floor = tokens
      isFloorDue = false
      await keepOwed($)
      if (fitted.taskCheckAt <= floor) {
        const lifted = liftLevels(fitted, floor, window)
        $.ui.toast(`auto-checkpoint: after compacting, the context is still ${Math.round(floor / 1000)}k; levels move up to ${Math.round(lifted.taskCheckAt / 1000)}k–${Math.round(lifted.forceAt / 1000)}k.`)
      }
      return result
    }

    // Both run after this dispatch: $.session.compact rejects while a turn runs.
    if (isDue) {
      // Past forceAt, stop waiting: a dev server or a monitor may never end.
      if (held > 0 && !(await isPast($, 'forceAt'))) {
        if (!isWaitingToasted) $.ui.toast(`auto-checkpoint: compacting after ${held} background task(s) finish; waiting for background work.`)
        isWaitingToasted = true
        return result
      }
      isCompacting = true
      $.clock.after(0, () => void compactNow($))
    } else if (e.reason === 'error' || (await isPast($, 'forceAt'))) {
      if (isVetoed) return result
      isCompacting = true
      $.clock.after(0, () => void forceCheckpoint($))
    } else if (isVetoed) {
      isVetoed = false
      await keepOwed($)
    }

    return result
  })
}
