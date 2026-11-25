/**
 * What the mod keeps in $.state, so a hot reload (a /config change) does not forget an owed compaction.
 * `floor`: the tokens a compaction left (its summary, the system prompt, the tools); levels below it move up by it.
 * `isFloorDue`: the next turn end measures the floor.
 */
export type Owed = { isDue: boolean; isResumeWanted: boolean; isVetoed: boolean; floor: number; isFloorDue: boolean }

declare module 'claude-code' {
  interface PluginState {
    'auto-checkpoint': { owed: Owed }
  }
}
