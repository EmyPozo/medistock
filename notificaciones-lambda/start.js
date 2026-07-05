// Arranca el worker (consumidor de RabbitMQ) y las Lambdas (serverless-offline)
// dentro del mismo contenedor para simplificar el despliegue local.
// En producción: el worker sería un servicio ECS/EC2 o una Lambda con trigger SQS,
// y las funciones HTTP se desplegarían con `serverless deploy` a AWS.
const { spawn } = require('child_process');

function run(name, cmd, args) {
  const p = spawn(cmd, args, { stdio: 'inherit', shell: true });
  p.on('exit', (code) => {
    console.log(`[${name}] terminó con código ${code}, reiniciando en 3s...`);
    setTimeout(() => run(name, cmd, args), 3000);
  });
}

run('worker', 'node', ['worker.js']);
run('lambdas', 'npx', ['serverless', 'offline', '--host', '0.0.0.0', '--httpPort', '3003']);
