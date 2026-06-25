/**
 * Infra Commands Index
 *
 * Re-exports all infra commands for registration in the main command handler.
 */

// Webhook commands
export { copyCommand, executeCopy } from './copy.js'
export { sendCommand, executeSend } from './send.js'

// Config commands
export { configCommand, executeConfig } from './config.js'
export { configSpeakersCommand, executeConfigSpeakers } from './config.js'
export { unsetConfigCommand, executeUnsetConfig } from './config.js'
export { getConfigCommand, executeGetConfig, autocompleteBotNames, autocompleteConfigKeys } from './get-config.js'

// History splice
export { historySpliceCommand, executeHistorySplice } from './history-splice.js'

// Debug/utility
export { transcriptCommand, executeTranscript } from './transcript.js'
export { getPromptCommand, executeGetPrompt } from './get-prompt.js'
export { getContextCommand, executeGetContext } from './get-context.js'

// Sleep commands
export { sleepCommand, executeSleep, wakeCommand, executeWake } from './sleep.js'

// Loom commands
export { forkCommand, executeFork } from './loom.js'
export { muCommand, executeMu } from './loom.js'
export { stashCommand, executeStash } from './loom.js'
export {
  forkContextMenu,
  forkPrivateContextMenu,
  muContextMenu,
  stashContextMenu,
  handleLoomContextMenu,
  handleLoomButton,
} from './loom.js'
