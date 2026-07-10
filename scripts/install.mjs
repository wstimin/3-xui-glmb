import { spawn } from 'node:child_process';

const steps = [
  ['install:check', ['run', 'install:check']],
  ['prisma:generate', ['run', 'prisma:generate']],
  ['prisma:migrate', ['run', 'prisma:migrate']],
  ['db:seed', ['run', 'db:seed']],
  ['build', ['run', 'build']],
  ['typecheck', ['run', 'typecheck']],
  ['deploy:check', ['run', 'deploy:check']]
];

for (const [name, args] of steps) {
  console.log(`\n==> ${name}`);
  await run('npm', args);
}

console.log('\nInstall pipeline completed. Start the API with: npm start');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}
