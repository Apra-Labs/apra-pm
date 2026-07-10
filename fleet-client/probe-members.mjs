import { McpClient } from './src/client/client.mjs';
import { StreamableHttpTransport } from './src/client/transport.mjs';
import { ApraFleet } from './src/client/api.mjs';

async function main() {
    const transport = new StreamableHttpTransport('http://127.0.0.1:7523/mcp');
    const client = new McpClient(transport);
    const api = new ApraFleet(client);

    try {
        console.log("Starting transport...");
        const readyPromise = new Promise(resolve => transport.on('ready', resolve));
        await transport.start();
        await readyPromise;

        console.log("Calling executeCommand with missing member...");
        const res = await api.executeCommand({ command: 'echo "test"', member_name: 'does_not_exist' });
        console.log("Raw Response:");
        console.dir(res, { depth: null });
        
        if (res.content && res.content.length > 0) {
            const data = JSON.parse(res.content[0].text);
            console.log("\nParsed Members:");
            console.dir(data, { depth: null });
        }
    } catch (e) {
        console.error("Error:", e);
    } finally {
        transport.stop();
    }
}
main();
