const { execSync } = require('child_process');
function run(cmd) { 
  console.log('Running:', cmd);
  const out = execSync(cmd, {encoding: 'utf8'}); 
  console.log(out);
  return out;
}

const goals = ['gh-toy-mi2', 'gh-toy-7rp', 'gh-toy-4ef'];

for (const goal of goals) {
  try {
    const fOut = run(`bd create --title "Feature for ${goal}" --type feature --parent ${goal} --priority 1 --force`);
    const featureId = fOut.match(/Created issue: ([^\s]+)/)[1];
    
    const iOut = run(`bd create --title "[impl] ${goal} impl" --description "Acceptance criteria: implementation complete" --type task --parent ${featureId} --priority 2 --force`);
    const implId = iOut.match(/Created issue: ([^\s]+)/)[1];
    
    const tOut = run(`bd create --title "[test] ${goal} test" --description "Acceptance criteria: integration tests pass" --type task --parent ${featureId} --priority 2 --force`);
    const testId = tOut.match(/Created issue: ([^\s]+)/)[1];
    
    run(`bd dep add ${goal} ${featureId}`);
    run(`bd dep add ${featureId} ${implId}`);
    run(`bd dep add ${featureId} ${testId}`);
    run(`bd dep add ${testId} ${implId}`);
    
    run(`bd update ${implId} --set-metadata model=standard --set-metadata bucket=M`);
    run(`bd update ${testId} --set-metadata model=cheap --set-metadata bucket=S`);
  } catch (e) {
    console.error(e);
  }
}
