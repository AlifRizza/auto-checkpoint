import { expect, test } from 'claude-code/testing'

import {
  DEFAULT_LEVELS,
  fitLevels,
  levelOf,
  liftLevels,
  noteFor,
  parseCheckpoint,
  parseDocCount,
  parseForced,
  parseLevels,
  resumePrompt,
  sekarangOf,
  stampOf,
  writeLog,
  splitArchive,
} from '../hooks/log'

const CP = {
  goal: 'Ship the CSV export',
  status: 'Dedup done on batch 15',
  next_step: 'Run the export for all batches',
  decisions: ['Match on email first'],
  results: ['Batch 15: 37 duplicates removed'],
  open: [],
}

test('levels: defaults, and any unusable or out-of-order value falls back to all defaults', async () => {
  expect(parseLevels({})).toEqual(DEFAULT_LEVELS)
  expect(parseLevels({ taskCheckAt: 100000, decideAt: 200000, mustAt: 300000, forceAt: 400000 })).toEqual({
    taskCheckAt: 100000,
    decideAt: 200000,
    mustAt: 300000,
    forceAt: 400000,
  })
  expect(parseLevels({ ...DEFAULT_LEVELS, decideAt: 300000 })).toEqual(DEFAULT_LEVELS)
  expect(parseLevels({ ...DEFAULT_LEVELS, taskCheckAt: 'lots' })).toEqual(DEFAULT_LEVELS)
  expect(parseLevels({ ...DEFAULT_LEVELS, taskCheckAt: 5000 })).toEqual(DEFAULT_LEVELS)
})

test('fitLevels: a smaller window scales every level to it; the 1M window and an unknown one keep them', async () => {
  expect(fitLevels(DEFAULT_LEVELS, 1_000_000)).toEqual(DEFAULT_LEVELS)
  expect(fitLevels(DEFAULT_LEVELS, undefined)).toEqual(DEFAULT_LEVELS)
  expect(fitLevels(DEFAULT_LEVELS, 200_000)).toEqual({ taskCheckAt: 80_000, decideAt: 120_000, mustAt: 170_000, forceAt: 180_000 })
})

test('fitLevels: levels set for a small window scale to their own forceAt, not to 1M', async () => {
  const mine = { taskCheckAt: 100_000, decideAt: 140_000, mustAt: 170_000, forceAt: 185_000 }
  expect(fitLevels(mine, 200_000)).toEqual({ taskCheckAt: 97_297, decideAt: 136_216, mustAt: 165_405, forceAt: 180_000 })
  expect(fitLevels({ ...mine, forceAt: 180_000 }, 200_000)).toEqual({ ...mine, forceAt: 180_000 })
})

test('levelOf: the highest level reached', async () => {
  expect(levelOf(undefined, DEFAULT_LEVELS)).toBe('none')
  expect(levelOf(399_999, DEFAULT_LEVELS)).toBe('none')
  expect(levelOf(400_000, DEFAULT_LEVELS)).toBe('task')
  expect(levelOf(600_000, DEFAULT_LEVELS)).toBe('decide')
  expect(levelOf(850_000, DEFAULT_LEVELS)).toBe('must')
  expect(levelOf(900_000, DEFAULT_LEVELS)).toBe('force')
})

test('notes: task note alone, then decide added below it, then must in its place', async () => {
  expect(noteFor('none', 100_000, DEFAULT_LEVELS)).toBeUndefined()

  const task = noteFor('task', 430_000, DEFAULT_LEVELS) ?? ''
  expect(task).toContain('Context: 430k tokens used, 470k before a forced checkpoint.')
  expect(task).toContain('If it fits in 470k, start.')
  expect(task).not.toContain('At the end of each sub-task')

  const decide = noteFor('decide', 650_000, DEFAULT_LEVELS) ?? ''
  expect(decide).toContain('Context: 650k tokens used, 250k before a forced checkpoint.')
  expect(decide).toContain('At the end of each sub-task, decide whether')
  expect(decide).toContain('Never stop in the middle of a sub-task to checkpoint.')

  const must = noteFor('must', 860_000, DEFAULT_LEVELS) ?? ''
  expect(must).toContain('The mod forces a checkpoint at 900k.')
  expect(must).not.toContain('At the end of each sub-task')
  expect(noteFor('force', 950_000, DEFAULT_LEVELS)).toContain('0k before a forced checkpoint')
})

test('parseCheckpoint: needs goal, status and next_step; lists default to empty', async () => {
  expect(parseCheckpoint({ goal: 'g', status: 's', next_step: 'n' })).toEqual({
    goal: 'g',
    status: 's',
    next_step: 'n',
    decisions: [],
    results: [],
    open: [],
  })
  expect(parseCheckpoint({ goal: 'g', status: ' ' })).toBe('checkpoint needs non-empty: status, next_step')
  expect(parseCheckpoint({ goal: 'g', status: 's', next_step: 'n', decisions: 'one' })).toBe(
    'checkpoint: decisions must be a list of strings',
  )
})

test('writeLog: a new file holds Sekarang and one Log entry', async () => {
  const text = writeLog('', CP, '2026-11-18 10:40 UTC')
  expect(text).toBe(
    [
      '# PROJECT_LOG',
      '<!-- auto-checkpoint -->',
      '',
      '## Sekarang',
      '**Goal:** Ship the CSV export',
      '**Status:** Dedup done on batch 15',
      '**Next step:** Run the export for all batches',
      '',
      '## Log',
      '',
      '### 2026-11-18 10:40 UTC',
      '**Decisions:**',
      '- Match on email first',
      '**Results:**',
      '- Batch 15: 37 duplicates removed',
      '',
    ].join('\n'),
  )
})

test('writeLog: Sekarang is replaced, earlier Log entries stay, the new one goes last', async () => {
  const first = writeLog('', CP, '2026-11-18 10:40 UTC')
  const second = writeLog(first, { ...CP, status: 'Export run', next_step: 'Compare counts', open: ['Batch 9 lacks emails'] }, '2026-11-18 12:00 UTC')
  expect(sekarangOf(second)).toBe('**Goal:** Ship the CSV export\n**Status:** Export run\n**Next step:** Compare counts')
  expect(second.indexOf('### 2026-11-18 10:40 UTC')).toBeLessThan(second.indexOf('### 2026-11-18 12:00 UTC'))
  expect(second).toContain('**Open:**\n- Batch 9 lacks emails')
  expect(second.match(/## Sekarang/g)?.length).toBe(1)
})

test('writeLog: your own sections between Sekarang and Log are kept in place', async () => {
  const first = writeLog('', CP, '2026-11-18 10:40 UTC')
  const mine = first.replace('\n## Log\n', '\n## Conventions\nTabs, not spaces.\n\n## Log\n')
  const second = writeLog(mine, { ...CP, status: 'Export run' }, '2026-11-18 12:00 UTC')
  expect(second).toContain('**Status:** Export run\n**Next step:**')
  expect(second).toContain('## Conventions\nTabs, not spaces.\n\n## Log\n')
  expect(second.match(/## Sekarang/g)?.length).toBe(1)
})

test('writeLog: a preamble above Sekarang is kept', async () => {
  const first = writeLog('', CP, '2026-11-18 10:40 UTC').replace('# PROJECT_LOG\n', '# PROJECT_LOG\nRead me first.\n')
  expect(writeLog(first, CP, '2026-11-18 12:00 UTC')).toContain('# PROJECT_LOG\nRead me first.\n<!-- auto-checkpoint -->\n\n## Sekarang\n')
})

test('writeLog: a file written by hand is kept under Log as earlier notes', async () => {
  const text = writeLog('my own notes\n', CP, '2026-11-18 10:40 UTC')
  expect(text).toContain('## Log\n\n### Earlier notes\nmy own notes\n\n### 2026-11-18 10:40 UTC')
})

test('sekarangOf: absent when the file has no Sekarang section, or the mod did not write it', async () => {
  expect(sekarangOf('')).toBeUndefined()
  expect(sekarangOf('# notes\n')).toBeUndefined()
  expect(sekarangOf('# PROJECT_LOG\n\n## Sekarang\n**Goal:** g\n')).toBeUndefined()
})

test('stampOf: minutes in UTC', async () => {
  expect(stampOf(Date.UTC(2026, 10, 18, 10, 40, 59))).toBe('2026-11-18 10:40 UTC')
})

const RESUME =
  'Resumed after a checkpoint. If your last answer before it asked the user a question, wait for their reply. Otherwise carry on from Next step in the project log, without waiting for the user.'

test('resumePrompt: graphify first only when docs changed; a question to the user waits for them', async () => {
  expect(resumePrompt(0)).toBe(RESUME)
  expect(resumePrompt(3)).toBe(`First run /graphify --update: 3 documents changed since the graph was built.\n${RESUME}`)
})

test('parseForced: reads the JSON object, fenced or not; anything else is undefined', async () => {
  expect(parseForced(JSON.stringify(CP))).toEqual(CP)
  expect(parseForced('```json\n' + JSON.stringify(CP) + '\n```')).toEqual(CP)
  expect(parseForced('sorry, no')).toBeUndefined()
  expect(parseForced('{"goal":"g"}')).toBeUndefined()
})

test('parseDocCount: the last line as a positive integer, else 0', async () => {
  expect(parseDocCount('warning\n3\n')).toBe(3)
  expect(parseDocCount('')).toBe(0)
  expect(parseDocCount('x')).toBe(0)
})

test('notes: on a 200k window the size guide scales with it', async () => {
  const small = fitLevels(DEFAULT_LEVELS, 200_000)
  const note = noteFor('task', 100_000, small, 200_000) ?? ''
  expect(note).toContain('Rough guide: one large file read 1-4k; a change across several files 20-40k; a long debugging session 40k or more.')
  expect(noteFor('task', 430_000, DEFAULT_LEVELS)).toContain('one large file read 5-20k; a change across several files 100-200k; a long debugging session 200k or more.')
})

test('writeLog: past 1 MiB the oldest Log entries move to the archive, newest kept', async () => {
  const big = 'x'.repeat(300_000)
  let text = ''
  for (let i = 0; i < 5; i++) text = writeLog(text, { ...CP, results: [`${i} ${big}`] }, `2026-11-18 1${i}:00 UTC`)
  const { log, archive } = splitArchive(text)
  expect(log.length).toBeLessThan(1_048_576)
  expect(log).toContain('### 2026-11-18 14:00 UTC')
  expect(log).toContain('## Sekarang')
  expect(archive).toContain('### 2026-11-18 10:00 UTC')
  expect(archive).not.toContain('### 2026-11-18 14:00 UTC')
  expect(splitArchive('small')).toEqual({ log: 'small', archive: '' })
})

test('liftLevels: levels below what a compaction leaves move up by it, spacing kept; never past 90% of the window', async () => {
  const low = { taskCheckAt: 20_000, decideAt: 30_000, mustAt: 40_000, forceAt: 50_000 }
  expect(liftLevels(low, 57_000, 1_000_000)).toEqual({ taskCheckAt: 77_000, decideAt: 87_000, mustAt: 97_000, forceAt: 107_000 })
  expect(liftLevels(DEFAULT_LEVELS, 80_000, 1_000_000)).toEqual(DEFAULT_LEVELS)
  expect(liftLevels(DEFAULT_LEVELS, 0, 1_000_000)).toEqual(DEFAULT_LEVELS)
  const small = fitLevels(DEFAULT_LEVELS, 200_000)
  expect(liftLevels(small, 80_000, 200_000)).toEqual(small)
})
