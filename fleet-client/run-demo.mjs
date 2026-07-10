import { createWorkflowEngine } from './src/client/factory.mjs';
import { startViewer } from './src/viewer/index.mjs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
    console.log('Connecting to apra-fleet...');
    const { engine } = await createWorkflowEngine({ transport: 'http', url: 'http://127.0.0.1:7523/mcp' });
    
    startViewer(engine.wf, { name: 'Demo Workflow' });
    
    console.log("--- DASHBOARD LIVE ---");
    console.log("Open http://localhost:8080 in your browser NOW!");
    console.log("----------------------");
    
    // Wait a couple seconds to give the user time to click the link
    await new Promise(r => setTimeout(r, 4000));
    
    console.log("Starting workflow...");
    const scriptPath = path.join(__dirname, 'examples', '02-sprint-runner.js');
    
    try {
        await engine.executeFile(scriptPath, {
            member_name: 'fleet-dev',
            issues: ['ISSUE-1', 'ISSUE-2'],
            max_cycles: 2
        });
    } catch (e) {
        console.error("Workflow threw an error:", e);
    }
    
    console.log("Workflow complete. Keeping the dashboard alive for 10 minutes so you can review it...");
    
    // Keep alive for 10 minutes
    await new Promise(r => setTimeout(r, 600000));
}

main().catch(console.error);
