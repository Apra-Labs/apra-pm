const { execSync } = require('child_process');

function run(cmd) {
    console.log(`Running: ${cmd}`);
    try {
        const out = execSync(cmd, { encoding: 'utf8' });
        console.log(out);
        return out;
    } catch (e) {
        console.error(e.stdout);
        console.error(e.stderr);
        throw e;
    }
}

const goals = ['gh-toy-mi2', 'gh-toy-7rp', 'gh-toy-4ef'];

for (const goal of goals) {
    // 1. Create a feature issue
    const featOut = run(`bd create --parent ${goal} --type feature --title "Feature for ${goal}" --desc "Acceptance criteria: feature is complete"`);
    const featIdMatch = featOut.match(/Created issue:\s+([^\s]+)/);
    const featId = featIdMatch ? featIdMatch[1] : null;

    if (featId) {
        // Wire sprint goal -> child (goal waits for children)
        // bd dep add <goal-id> <child-id>
        run(`bd dep add ${goal} ${featId}`);

        // 2. Create impl task
        const implOut = run(`bd create --parent ${featId} --type task --title "Impl ${goal}" --desc "Acceptance criteria: implementation complete"`);
        const implIdMatch = implOut.match(/Created issue:\s+([^\s]+)/);
        const implId = implIdMatch ? implIdMatch[1] : null;

        // 3. Create test task
        const testOut = run(`bd create --parent ${featId} --type task --title "[test] ${goal}" --desc "Acceptance criteria: tests pass"`);
        const testIdMatch = testOut.match(/Created issue:\s+([^\s]+)/);
        const testId = testIdMatch ? testIdMatch[1] : null;

        if (implId && testId) {
            // Assign tier and bucket
            run(`bd update ${implId} --set-metadata model=cheap --set-metadata bucket=S`);
            run(`bd update ${testId} --set-metadata model=cheap --set-metadata bucket=S`);

            // Wire feature -> tasks
            run(`bd dep add ${featId} ${implId}`);
            run(`bd dep add ${featId} ${testId}`);

            // Wire test after impl
            run(`bd dep add ${testId} ${implId}`);
        }
    }
}

console.log("Done!");
