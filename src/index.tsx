#!/usr/bin/env node
// Keep this at the top so that the dist/index.js file becomes executable

import open from 'open';
import './polyfills.js'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { Client } from '@xmtp/xmtp-js'
import inquirer from 'inquirer';
import fsExtra from 'fs-extra';
import fs from 'fs';
import path from 'path';
import download from 'download';
import decompress from 'decompress';
import dotenv from 'dotenv';
import os from 'os';

async function getAgentPort(): Promise<string> {
  const portQuestion = [
    {
      type: 'input',
      name: 'port',
      message: 'What port is your agent running on? This is usually found in your Dockerfile as the last command',
    },
  ];

  const portAnswer = await inquirer.prompt(portQuestion);
  const port = portAnswer.port;

  if (isNaN(parseFloat(port)) || port.length !== 4) {
    console.log('Please enter a 4-digit port number');
    return getAgentPort();
  }

  return port;
}
async function getAgentEndpoint(): Promise<string> {
  const endpointQuestion = [
    {
      type: 'input',
      name: 'endpoint',
      message: `Provide the endpoint/route name for your agent.
For example, if your FastAPI app route is: app.post("/entrypoint"), just type "entrypoint" without the quotes and press enter.\n`,
    },
  ];

  const endpointAnswer = await inquirer.prompt(endpointQuestion);
  return endpointAnswer.endpoint;
}

async function findKeyBundleInDownloads() {
  const homeDir = os.homedir();
  const directories = fs.readdirSync(homeDir);

  const downloadsDir = directories.find(dir => dir.toLowerCase() === 'downloads');

  if (!downloadsDir) {
    console.log('Could not find a downloads directory');
    return [];
  }

  const downloadsPath = path.join(homeDir, downloadsDir);
  const files = fs.readdirSync(downloadsPath);

  const keyBundleFiles = files.filter(file => file.endsWith('XMTPbundle.txt')); // replace 'XMTPbundle.txt' with the actual extension of your key bundle files

  return keyBundleFiles.map(file => path.join(downloadsPath, file));
}

async function getKeyBundlePath(): Promise<string> {
  const searchQuestion = [
    {
      type: 'confirm',
      name: 'search',
      message: 'Automatically look for key bundle in your downloads?',
      default: true,
    },
  ];

  const { search } = await inquirer.prompt(searchQuestion);

  if (search) {
    const keyBundleFiles = await findKeyBundleInDownloads();

    if (keyBundleFiles.length > 0) {
      console.log('Potential key bundles found:');
      const bundleFileQuestions = [
        {
          type: 'list',
          name: 'keyBundlePath',
          message: 'Select a key bundle:',
          choices: keyBundleFiles,
        },
      ];

      const bundleFileAnswers = await inquirer.prompt(bundleFileQuestions);
      return bundleFileAnswers.keyBundlePath;
    } else {
      console.log('No key bundles found in downloads directory');
    }
  }

  const bundleFileQuestions = [
    {
      type: 'input',
      name: 'keyBundlePath',
      message: 'Provide the path to your downloaded key bundle',
    },
  ];

  const bundleFileAnswers = await inquirer.prompt(bundleFileQuestions);
  const filePath = path.resolve(bundleFileAnswers.keyBundlePath);

  if (!fs.existsSync(filePath)) {
    console.log(`Invalid path: ${filePath}. Please try again.`);
    return getKeyBundlePath();
  }

  return filePath;
}

function readKeyBundle(keyBundlePath: string): Buffer {
  const keyBundleBinary = fs.readFileSync(keyBundlePath, 'utf-8');
  return Buffer.from(keyBundleBinary, 'binary');
}

async function createClient(keyBundle: Buffer): Promise<Client> {
  try {
    const client = await Client.create(null, {
      env: "production",
      privateKeyOverride: keyBundle
    });
    return client;
  } catch (error) {
    console.error('Failed to create XMTP client:', error);
    process.exit(1);
  }
}

async function promptOverwrite(): Promise<boolean> {
  const overwriteQuestion = [
    {
      type: 'list',
      name: 'overwrite',
      message: 'XMTP_KEY already exists in .env, do you want to overwrite it?',
      choices: ['Yes', 'No'],
    },
  ];
  const overwriteAnswer = await inquirer.prompt(overwriteQuestion);
  return overwriteAnswer.overwrite === 'Yes';
}

// TODO: these updateEnvFile functions can be refactored into 1 function
// just need to make sure the regex and everything works
function updateEnvFile(keyBundle: Buffer): void {
  console.log('Generating .env file...');
  const envContent = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
  let newEnvContent;
  if (envContent.includes('XMTP_KEY')) {
    newEnvContent = envContent.replace(/^XMTP_KEY=.*$/m, `XMTP_KEY=${keyBundle.toString('base64')}`);
  } else {
    newEnvContent = `XMTP_KEY=${keyBundle.toString('base64')}\n${envContent}`;
  }
  fs.writeFileSync(path.join(process.cwd(), '.env'), newEnvContent);
}
function updateEnvFileWithPort(port: string): void {
  console.log('Updating .env file with agent port...');
  const envContent = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
  let newEnvContent;
  if (envContent.includes('AGENT_PORT')) {
    newEnvContent = envContent.replace(/^AGENT_PORT=.*$/m, `AGENT_PORT=${port}`);
  } else {
    newEnvContent = `AGENT_PORT=${port}\n${envContent}`;
  }
  fs.writeFileSync(path.join(process.cwd(), '.env'), newEnvContent);
  process.env.AGENT_PORT = port;
}
function updateEnvFileWithEndpoint(endpoint: string): void {
  console.log('Updating .env file with agent endpoint...');
  const envContent = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
  let newEnvContent;
  if (envContent.includes('AGENT_ENDPOINT')) {
    newEnvContent = envContent.replace(/^AGENT_ENDPOINT=.*$/m, `AGENT_ENDPOINT=${endpoint}`);
  } else {
    newEnvContent = `AGENT_ENDPOINT=${endpoint}\n${envContent}`;
  }
  fs.writeFileSync(path.join(process.cwd(), '.env'), newEnvContent);
}
async function getConsentToDownloadService(): Promise<boolean> {
  const consentQuestion = [
    {
      type: 'confirm',
      name: 'consent',
      message: `For your agent to communicate, we need to run a service that runs in your machine next to the agent. It handles passing messages between your agent and your agent\'s users. 

Is it okay to download this service? You can find more details here: 
https://github.com/operatorlabs/gateway/src/templates/xmtp-service.js\n`,
      default: false,
    },
  ];

  const consentAnswer = await inquirer.prompt(consentQuestion);
  return consentAnswer.consent;
}

async function downloadTemplates() {
  try {
    const cwd = process.cwd();
    const data = await download('https://github.com/operatorlabs/gateway/archive/refs/heads/main.zip');
    console.log('Download complete. Size:', data.length, 'bytes.', 'Current directory:', cwd);
    await fsExtra.writeFile(path.join(cwd, 'main.zip'), data);

    console.log('Starting decompression...');
    const files = await decompress(path.join(cwd, 'main.zip'), cwd, {
      filter: file => file.path.startsWith('gateway-main/templates/'),
      map: file => {
        file.path = file.path.replace('gateway-main/templates/', 'xmtp-service/');
        return file;
      }
    });
    console.log('Decompression complete. Files:', files.map(file => file.path));

    console.log('Removing files and cleaning up...');
    await fsExtra.unlink(path.join(cwd, 'main.zip'));
    await fsExtra.remove(path.join(cwd, 'gateway-main'));
    console.log('Finished cleaning up')

    const dockerComposePath = path.join(cwd, 'docker-compose.yml');
    const dockerComposeServicePath = path.join(cwd, 'xmtp-service', 'docker-compose.yml');

    if (fs.existsSync(dockerComposePath)) {
      const overwriteQuestion = [
        {
          type: 'confirm',
          name: 'overwrite',
          message: 'Found existing docker-compose.yml file, is it okay to remove it?',
          default: false,
        },
      ];

      const { overwrite } = await inquirer.prompt(overwriteQuestion);

      if (!overwrite) {
        console.log('Process quit by user.');
        process.exit(0);
      }

      fs.unlinkSync(dockerComposePath);
    } else {
      console.log("Could not find docker-compose.yml");
    }
    fs.renameSync(dockerComposeServicePath, dockerComposePath);

    // Read the contents of the docker-compose.yml file
    let dockerComposeContent = fs.readFileSync(dockerComposePath, 'utf8');

    // Ensure process.env.AGENT_PORT is defined
    const agentPort = process.env.AGENT_PORT;
    if (!agentPort) {
      throw new Error('AGENT_PORT is not defined in the environment variables');
    }

    // Replace all instances of AGENT_PORT with process.env.AGENT_PORT
    dockerComposeContent = dockerComposeContent.replace(/AGENT_PORT/g, agentPort);

    // Write the updated contents back to the docker-compose.yml file
    fs.writeFileSync(dockerComposePath, dockerComposeContent);

  } catch (error) {
    console.error('An error occurred:', error);
  }
}

async function createMultistageDockerfile() {
  if (fs.existsSync(path.join(process.cwd(), 'Dockerfile'))) {
    const overwriteQuestion = [
      {
        type: 'confirm',
        name: 'overwrite',
        message: 'Detected existing Dockerfile. A new Dockerfile needs to be generated, is it okay to rename this old-dockerfile.txt?',
        default: false,
      },
    ];

    const overwriteAnswer = await inquirer.prompt(overwriteQuestion);

    if (!overwriteAnswer.overwrite) {
      console.log('Process quit by user.');
      process.exit(0);
    }
    fs.renameSync(path.join(process.cwd(), 'Dockerfile'), path.join(process.cwd(), 'old-dockerfile.txt'));
  }
  fs.writeFileSync(path.join(process.cwd(), 'Dockerfile'), '');

  const oldDockerfileContent = fs.readFileSync(path.join(process.cwd(), 'old-dockerfile.txt'), 'utf8');
  // const xmtpServiceDockerfileContent = fs.readFileSync(path.join(process.cwd(), 'xmtp-service', 'Dockerfile'), 'utf8');

  // const filteredOldDockerfileContent = oldDockerfileContent.split('\n').filter(line => !line.match(/^CMD /i) && line.trim() !== '').join('\n');
  let cmdLine = '';
  const filteredOldDockerfileContent = oldDockerfileContent.split('\n').filter(line => {
    if (line.match(/^CMD /i)) {
      cmdLine = line.replace(/^CMD /i, '').trim();
      if (cmdLine.startsWith('[') && cmdLine.endsWith(']')) {
        cmdLine = cmdLine.slice(1, -1).split(',').map(s => s.trim().replace(/^"|"$/g, '')).join(' ');
      }
      return false;
    }
    return line.trim() !== '';
  }).join('\n');

  // see if the command contains --host parameter and if it's set to localhost
  const hostRegex = /(--host\s+)([^\s]+)/;
  const hostMatch = cmdLine.match(hostRegex);
  if (hostMatch) {
    if (hostMatch[2] !== 'localhost') {
      cmdLine = cmdLine.replace(hostRegex, (match, p1, p2) => `${p1}localhost`);
    }
  }

  const envContent = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
  if (envContent.includes('AGENT_RUN_COMMAND')) {
    const overwriteQuestion = [
      {
        type: 'list',
        name: 'overwrite',
        message: 'AGENT_RUN_COMMAND exists in .env, do you want to overwrite it?',
        choices: ['Overwrite'],
      },
    ];
    await inquirer.prompt(overwriteQuestion);
  }

  let newEnvContent;
  if (envContent.includes('AGENT_RUN_COMMAND')) {
    newEnvContent = envContent.replace(/^AGENT_RUN_COMMAND=.*$/m, `AGENT_RUN_COMMAND=${cmdLine}`);
  } else {
    newEnvContent = `AGENT_RUN_COMMAND=${cmdLine}\n${envContent}`;
  }
  fs.writeFileSync(path.join(process.cwd(), '.env'), newEnvContent);

  // const filteredXmtpServiceDockerfileContent = xmtpServiceDockerfileContent.split('\n').filter(line => !line.match(/^CMD /i) && line.trim() !== '').join('\n');

  // fs.appendFileSync(path.join(process.cwd(), 'Dockerfile'), filteredOldDockerfileContent + '\n\n' + filteredXmtpServiceDockerfileContent + '\n');

  // TODO: needs to be tested further but should be fine for now, as long as the Dockerfile they have works and is in root.
  const finalImageInstructions = `
# Start with the Python base image
FROM python:3.11-slim-buster AS python-base
WORKDIR /app
COPY ./ /app
RUN pip install --no-cache-dir -r requirements.txt

# Then use the Node.js base image
FROM node:17 AS node-base
WORKDIR /app
COPY ./xmtp-service/package*.json ./
RUN npm install
COPY ./xmtp-service .

# Final image
FROM debian:buster
RUN apt-get update && apt-get install -y supervisor curl

# Copy Python environment from python-base
COPY --from=python-base /usr/local /usr/local

# Copy Node.js environment from node-base
COPY --from=node-base /usr/local /usr/local

# Copy app files from python-base
COPY --from=python-base /app /app

# Copy app files from node-base
COPY --from=node-base /app /xmtp-service

# Copy supervisor configuration
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

CMD ["/usr/bin/supervisord"]
  `;

  fs.appendFileSync(path.join(process.cwd(), 'Dockerfile'), finalImageInstructions);
}

async function moveSupervisordConf() {
  const cwd = process.cwd();
  const supervisordConfPath = path.join(cwd, 'supervisord.conf');
  const supervisordConfServicePath = path.join(cwd, 'xmtp-service', 'supervisord.conf');

  // Check if supervisord.conf exists in root
  if (fs.existsSync(supervisordConfPath)) {
    const overwriteQuestion = [
      {
        type: 'confirm',
        name: 'overwrite',
        message: 'Detected existing supervisord.conf in root, is it okay to rename this old-supervisord.conf?',
        default: false,
      },
    ];

    const { overwrite } = await inquirer.prompt(overwriteQuestion);
    if (!overwrite) {
      console.log('Process quit by user.');
      process.exit(0);
    }
    fs.renameSync(supervisordConfPath, path.join(cwd, 'old-supervisord.conf'));
  }
  fs.renameSync(supervisordConfServicePath, supervisordConfPath);

  // Now deal with the command replacement
  const envContent = fs.readFileSync(path.join(cwd, '.env'), 'utf8');
  const envVars = dotenv.parse(envContent);
  const agentRunCommand = envVars['AGENT_RUN_COMMAND'];

  let supervisordConfContent = fs.readFileSync(supervisordConfPath, 'utf8');
  supervisordConfContent = supervisordConfContent.replace('AGENT_RUN_COMMAND', agentRunCommand);
  fs.writeFileSync(supervisordConfPath, supervisordConfContent);
}

function switchXmtpService() {
  console.log("Switching xmtp-service.js files...");
  const xmtpServicePath = path.join(process.cwd(), 'xmtp-service');
  const xmtpServiceJsPath = path.join(xmtpServicePath, 'xmtp-service.js');
  const supervisordXmtpServiceJsPath = path.join(xmtpServicePath, 'supervisord-xmtp-service.js');

  if (fs.existsSync(xmtpServiceJsPath) && fs.existsSync(supervisordXmtpServiceJsPath)) {
    fs.renameSync(xmtpServiceJsPath, path.join(xmtpServicePath, 'compose-xmtp-service.js'));
    fs.renameSync(supervisordXmtpServiceJsPath, xmtpServiceJsPath);
    console.log("Files switched. Your old xmtp-service.js is now compose-xmtp-service.js");
  } else {
    console.error('xmtp-service.js or supervisord-xmtp-service.js does not exist in the xmtp-service directory.');
    process.exit(1);
  }
}

// TODO: this is repetitive with essentially the same step that happens later
async function checkAndModifyDockerfile() {
  const dockerfilePath = path.join(process.cwd(), 'Dockerfile');
  if (!fs.existsSync(dockerfilePath)) {
    console.error('Error: Dockerfile not found in the root directory.');
    process.exit(1);
  }
  console.log("Checking Dockerfile...");
  let dockerfileContent = fs.readFileSync(dockerfilePath, 'utf8');
  let cmdLine = '';
  const filteredDockerfileContent = dockerfileContent.split('\n').filter(line => {
    if (line.match(/^CMD /i)) {
      cmdLine = line.replace(/^CMD /i, '').trim();
      return false;
    }
    return line.trim() !== '';
  }).join('\n');

  const hostRegex = /(--host\s+)([^\s]+)/;
  const hostMatch = cmdLine.match(hostRegex);
  if (hostMatch) {
    if (hostMatch[2] !== 'localhost') {
      cmdLine = cmdLine.replace(hostRegex, (match, p1, p2) => `${p1}localhost`);
      console.log('Replacing host in Dockerfile with localhost...');
    }
  } else if (cmdLine.startsWith('[') && cmdLine.endsWith(']')) {
    const cmdArray = JSON.parse(cmdLine);
    const hostIndex = cmdArray.indexOf('--host');
    if (hostIndex !== -1 && cmdArray[hostIndex + 1] !== 'localhost') {
      cmdArray[hostIndex + 1] = 'localhost';
      cmdLine = JSON.stringify(cmdArray);
      console.log('Replacing host in Dockerfile with localhost...');
    }
  }

  dockerfileContent = dockerfileContent.replace(/(^|\n)CMD .*/i, `$1CMD ${cmdLine}`);
  fs.writeFileSync(dockerfilePath, dockerfileContent);
}

yargs(hideBin(process.argv))
  .command(
    'launch',
    'Launch your agent',
    {},
    async (argv: any) => {

      const dockerfilePath = path.join(process.cwd(), 'Dockerfile');
      if (!fs.existsSync(dockerfilePath)) {
        console.error('Error: Dockerfile not found in the root directory.');
        process.exit(1);
      }

      if (!fs.existsSync(path.join(process.cwd(), '.env'))) {
        console.error('Error: .env file not found in the root directory.');
        process.exit(1);
      }
      const keyBundleOptions = [
        {
          type: 'list',
          name: 'keyBundleSource',
          message: 'Please choose how you want to get your XMTP key bundle:',
          choices: ['Take me there', 'I want to generate my key bundle locally'],
        },
      ];
      const keyBundleAnswers = await inquirer.prompt(keyBundleOptions);

      if (keyBundleAnswers.keyBundleSource === 'Take me there') {
        await open('https://xmtpkeys.fly.dev');
      } else {
        await open('https://github.com/operatorlabs/xmtp-keygen');
      }
      const keyBundlePath = await getKeyBundlePath();
      const keyBundle = readKeyBundle(keyBundlePath);
      const client = await createClient(keyBundle);
      if (client) {
        console.log("Successfully created client from file")
      }

      // Handle process of generating XMTP client from the env key we just made
      dotenv.config();
      let envKey = process.env.XMTP_KEY;
      if (envKey) {
        const overwrite = await promptOverwrite();
        if (!overwrite) {
          console.log('Process quit by user.');
          process.exit(0);
        }
      }
      updateEnvFile(keyBundle);

      dotenv.config();
      envKey = process.env.XMTP_KEY;
      if (envKey) {
        const envKeyBundle = Buffer.from(envKey, 'base64');
        const envClient = await createClient(envKeyBundle);
        if (envClient) {
          console.log("Successfully created client from .env variable")
        }
      } else {
        console.log('XMTP_KEY not found in environment variables');
      }

      const deleteQuestions = [
        {
          type: 'list',
          name: 'delete',
          message: `Delete ${keyBundlePath}?`,
          choices: ['Yes', 'No'],
        },
      ];
      const deleteAnswers = await inquirer.prompt(deleteQuestions);

      if (deleteAnswers.delete === 'Yes') {
        console.log(`Deleting file ${keyBundlePath}...`);
        fs.unlinkSync(keyBundlePath);
        console.log('Successfully deleted.');
      }

      const agentPort = await getAgentPort();
      updateEnvFileWithPort(agentPort);

      const agentEndpoint = await getAgentEndpoint();
      updateEnvFileWithEndpoint(agentEndpoint);

      const consent = await getConsentToDownloadService();
      if (!consent) {
        console.log('Process quit by user.');
        process.exit(0);
      }

      // Check if the folder already exists so we don't accidentally overwrite stuff
      if (fs.existsSync(path.join(process.cwd(), 'xmtp-service'))) {
        const removeQuestion = [
          {
            type: 'confirm',
            name: 'remove',
            message: 'xmtp-service directory exists in root. Is it okay to remove it?',
            default: false,
          },
        ];

        const removeAnswer = await inquirer.prompt(removeQuestion);
        if (!removeAnswer.remove) {
          console.log('Process quit by user.');
          process.exit(0);
        }

        await fsExtra.remove(path.join(process.cwd(), 'xmtp-service'));
      }

      // Download files then check that everything's all there
      await downloadTemplates();
      console.log('Verifying download...');

      // Check if the folder itself exists
      if (!fs.existsSync(path.join(process.cwd(), 'xmtp-service'))) {
        console.log('Error: xmtp-service folder not found.');
        process.exit(1);
      }

      const files = ['Dockerfile', 'package.json', 'xmtp-service.js', 'supervisord-xmtp-service.js', 'supervisord.conf'];
      let missingFiles: string[] = [];

      // Now check for each file in the folder, and keep track of what is missing
      files.forEach(file => {
        if (!fs.existsSync(path.join(process.cwd(), 'xmtp-service', file))) {
          missingFiles.push(file);
        }
      });

      // See if everything exists
      if (missingFiles.length === 0) {
        console.log('Service downloaded to xmtp-service/');
      } else {
        console.log('Error: The following files were not copied successfully: ', missingFiles.join(', '));
      }

      const questions = [
        {
          type: 'list',
          name: 'nextStep',
          message: 'Your agent is now set up! You can exit and type `docker-compose up --build` to run your agent service locally.',
          choices: ["I'm done for now", "Deploy to traditional cloud providers", "Deploy to modern infra (e.g. Fly.io)"],
        },
      ];

      const answers = await inquirer.prompt(questions);

      switch (answers.nextStep) {
        case "I'm done for now":
          console.log("Thank you for setting up your agent. You can register a name with this agent's address on app.operator.io");
          break;
        case "Deploy to traditional cloud providers":
          console.log("Traditional cloud providers support deployment using docker compose in different ways. We recommend using phind.com to help you quickly navigate the deployment for the cloud provider you choose");
          break;
        case "Deploy to modern infra (e.g. Fly.io)":
          const deployOptions = [
            {
              type: 'list',
              name: 'deployTo',
              message: 'Where are you deploying to?',
              choices: ["Fly.io", "Other"],
            },
          ];

          const deployAnswers = await inquirer.prompt(deployOptions);

          if (deployAnswers.deployTo === "Other") {
            console.log("Not supported at this time");
          } else {
            const flyOptions = [
              {
                type: 'list',
                name: 'flySetup',
                message: 'Please continue if you have set up your Fly.io account and CLI',
                choices: ['Continue'],
              },
            ];

            await inquirer.prompt(flyOptions);

            const supervisordOptions = [
              {
                type: 'list',
                name: 'supervisordSetup',
                message: 'The next several steps will walk through setting up supervisord. You may choose to do this yourself by following the instructions listed here: https://github.com/operatorlabs/gateway/blob/main/README.md#using-supervisord. Doing things yourself may be preferred if you have a more custom directory structure or Dockerfile.',
                choices: ['Do it myself', 'Continue guided setup'],
              },
            ];

            const supervisordAnswers = await inquirer.prompt(supervisordOptions);

            if (supervisordAnswers.supervisordSetup === 'Do it myself') {
              console.log('Exiting setup. You can follow the instructions to set up supervisord yourself.');
              process.exit(0);
            }

            await createMultistageDockerfile();
            switchXmtpService();
            await moveSupervisordConf();

            const finalOptions = [
              {
                type: 'list',
                name: 'finalStep',
                message: 'All your configuration files should be set up, and you can now try running things locally with Docker, then deploy to Fly. You can follow along from step 4 in this guide: https://github.com/operatorlabs/gateway/blob/main/README.md#using-supervisord',
                choices: ['Exit', 'Register a name for my agent'],
              },
            ];

            const finalAnswers = await inquirer.prompt(finalOptions);

            if (finalAnswers.finalStep === 'Register a name for my agent') {
              await open('https://app.operator.io');
            }


          }
          break;
      }

    }
  )
  .demandCommand(1)
  .parse()