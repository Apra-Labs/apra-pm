/**
 * @typedef {Object} ExecutePromptOptions
 * @property {string} prompt - The prompt to send to the LLM on the remote member
 * @property {string} [agent] - Optional agent name to activate
 * @property {number} [max_total_s] - Hard ceiling in seconds
 * @property {number} [max_turns] - Max turns for claude -p (default: 50)
 * @property {string} [member_id] - UUID of the member
 * @property {string} [member_name] - Friendly name of the member
 * @property {string} [model] - Model tier ("cheap", "standard", "premium") or a specific model ID
 * @property {boolean} [resume] - Resume the previous session if one exists (default: true)
 * @property {Record<string, string>} [substitutions] - Optional map of token name to replacement value
 * @property {number} [timeout_s] - Inactivity timeout in seconds (default: 300)
 */

/**
 * @typedef {Object} ExecuteCommandOptions
 * @property {string} command - The shell command to execute
 * @property {boolean} [long_running] - Run as background task
 * @property {number} [max_retries] - Max crash retries (long_running only)
 * @property {string} [member_id] - UUID of the member
 * @property {string} [member_name] - Friendly name of the member
 * @property {string} [restart_command] - Command for retry runs, e.g. checkpoint resume
 * @property {string} [run_from] - Override directory to run from
 * @property {number} [timeout_s] - Timeout in seconds (default: 120)
 */

/**
 * @typedef {Object} ListMembersOptions
 * @property {"compact" | "json"} [format] - Output format
 * @property {string[]} [tags] - Filter members by tags (AND semantics)
 */

/**
 * @typedef {Object} FleetStatusOptions
 * @property {"compact" | "json"} [format] - Output format
 */

export class ApraFleet {
    /**
     * @param {{ callTool: (name: string, args: Record<string, any>) => Promise<any> }} mcpClient 
     */
    constructor(mcpClient) {
        this.mcpClient = mcpClient;
    }

    /**
     * Run an AI prompt on a member.
     * @param {ExecutePromptOptions} options
     */
    async executePrompt(options) {
        return this.mcpClient.callTool('execute_prompt', options);
    }

    /**
     * Run a shell command on a member.
     * @param {ExecuteCommandOptions} options
     */
    async executeCommand(options) {
        return this.mcpClient.callTool('execute_command', options);
    }

    /**
     * List all fleet members and their current status.
     * @param {ListMembersOptions} [options]
     */
    async listMembers(options = {}) {
        return this.mcpClient.callTool('list_members', options);
    }

    /**
     * Get status of all fleet members.
     * @param {FleetStatusOptions} [options]
     */
    async fleetStatus(options = {}) {
        return this.mcpClient.callTool('fleet_status', options);
    }
}
