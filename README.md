# Operator Gateway CLI

## Setup

### Prerequisities
- Node.js version >16.7
- Browser wallet extension such as Metamask, Rainbow, Coinbase Wallet, etc.
- A unique Ethereum EOA/non-AA address. Just go to your browser wallet extension like Metamask and add a new account.
- Existing FastAPI app for your agent, with a route that takes a POST request with a "message" parameter in the body. This parameter will carry the user's request to your agent.
- Docker installed locally

### Installation

1. `npm install -g @operatorlabs/cli` 
2. To launch your agent, run `agent launch` and follow the instructions.
3. At the end of the process, you should have a docker-compose.yml file you can use to deploy. However, you may want to deploy in a quick and easy fashion rather than deal with AWS or Azure or the like. We recommend fly.io for this purpose. 

### Deployment

#### Using docker compose

You should have a generated docker-compose.yml file that you can use to deploy to traditional cloud providers such as AWS, Azure, GCP, etc. You can also "deploy" locally by running `docker compose up --build` and this will run your agent on your computer, but it will be accessible by everyone by XMTP.

#### Using supervisord

If you don't want to deal with traditional cloud providers, there are other options such as Railway, Modal, Fly. We recommend using fly.io as they provide a seamless deployment and management experience with out of the box logging and scaling. Unfortunately, Fly does not accept docker compose as a means of deployment so we have to make some changes.
Instead of using docker compose to manage running two processes at the same time, we can use supervisord. You can install supervisord by following these steps: http://supervisord.org/installing.html but it isn't necessary if you are only going to be building and running your application by following these instructions, as the Dockerfile we create will handle installing supervisord.

1. In the root of your repo, once you finish the CLI process you should have a Dockerfile and a docker-compose.yml. You can keep these files if you want, but they won't be used anymore after step 2. The Dockerfile, if you want to keep it, needs to be renamed to something like old-dockerfile.txt. If you don't want to keep it, you can throw it away after the next step. You will also have two files in your xmtp-service/ directory, xmtp-service.js and supervisord-xmtp-service.js. Since we are now using supervisord, you must switch these files around like so: rename xmtp-service.js to compose-xmtp-service.js, then rename supervisord-xmtp-service.js to xmtp-service.js.

2. We need to create a new Dockerfile in the root that runs a multi-stage build. Here is how to build it:

```
# Start with the Python base image. This should be basically the same as your previous Dockerfile for your FastAPI app, without running the CMD to actually start your app. 

FROM python:3.11-slim-buster AS python-base
WORKDIR /app
COPY ./ /app
RUN pip install --no-cache-dir -r requirements.txt

# Now it's time to build the xmtp-service Node.js app

FROM node:17 AS node-base
WORKDIR /app
COPY ./xmtp-service/package*.json ./
RUN npm install
COPY ./xmtp-service .

# Next we get the final image and get supervisor so we can run both the FastAPI and Node app together
# Note that we use the buster image here, just like we did for the python 3.11 image. This is to prevent compatibility errors regarding the GNU C Library (GLIBC), where the Python binary might be compiled against a different version of GLIBC than what is actually available in the Docker container we are building.

FROM debian:buster
RUN apt-get update && apt-get install -y supervisor curl

# Now we copy both the Python and Node environments from python-base and node-base so we can access them
COPY --from=python-base /usr/local /usr/local
COPY --from=node-base /usr/local /usr/local

# Do the same with app files for both the FastAPI app and the Node.js app (xmtp-service)
COPY --from=python-base /app /app
COPY --from=node-base /app /xmtp-service

# Copy over the supervisor configuration (don't worry, we'll create this in the next step)
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Start the application using supervisor
CMD ["/usr/bin/supervisord"]
```

3. We need to create the supervisord.conf file that is being referenced in our new Dockerfile. In the root of your project, the same directory that your Dockerfile lives, create a file called supervisord.conf. Here is what it should look like:

```
[supervisord]
; just log to stdout so you can see everything in the fly monitoring
logfile=/dev/stdout 
logfile_maxbytes=0  
loglevel=info
pidfile=/tmp/supervisord.pid
nodaemon=true
user=root

[program:agent-api]
command=uvicorn main:app --host 0.0.0.0 --port 8000
directory=/app
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0

[program:xmtp-service]
command=node xmtp-service.js
directory=/xmtp-service
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
```

The only potential modifications you need to make are to the command and directory settings for each program. however, if you followed the Dockerfile setup from step 2, you should not have to.

4. Now you can test whether it all works locally. First, make sure you have Docker installed and running on your computer. It is helpful to have Docker Desktop installed and open as well so you can easily start/stop/delete images and containers. Here are the commands you should run, all from the root of your project (where your Dockerfile is located)

```
# Build your Docker image, and call it test-agent-api or whatever you want
docker build -t test-agent-api .

# You can check Docker Desktop and see if your image is there

# Now run your image in a container locally, including the .env secrets. Instead of test-agent-api-container, you can obviously name it whatever you want.
docker run -d --env-file .env --name test-agent-api-container test-agent-api

# You can check Docker Desktop and click containers, and your container name should show up as running.

# Verify that your commands used to run both apps are accessible
docker exec -it test-agent-api-container which uvicorn
docker exec -it test-agent-api-container which node

# Both should show some valid path, like /usr/local. If nothing shows up, that means your application will not run.

# Load up the logs
docker logs -f test-agent-api-container
```

5. Your container is running now, and with the last docker logs command you should see a stream of logs from your container. Now you can use any XMTP client such as Converse or Coinbase Wallet and send your agent's address a message. You should see the logs update as the agent processes the message. This means you are ready to deploy. Now before you do the next step, check your `supervisord.conf` file and make sure the host is set to `localhost` instead of `0.0.0.0`:

```
[program:agent-api]
command=uvicorn main:app --host 0.0.0.0 --port 8000
```

7. First go to fly.io and follow instructions to install their CLI, set up an account, etc. Once it's all set up and you can verify the CLI is working on your machine, run `fly launch` in the root of your project. It should utilize your existing Dockerfile. Even though this will create your application on Fly, it will not actually work yet.

6. Fly.io has their own secrets management service, so the last thing to do before deploying is to take every secret used from your .env file and set them as Fly secrets. You can do this in Fly.io by navigating to your application you just made, and setting the secrets there. Or you can do it in the CLI like so:

`fly secrets set SECRET_1=asdf SECRET_2=asdf`

The secrets you definitely need to include should be AGENT_PORT, AGENT_ENDPOINT, and XMTP_KEY.

7. Once the secrets are set, your application should redeploy. Go to your application in Fly.io's web application and click the 'Monitoring' tab. Now try messaging your agent - you should see whatever output you expect based on yoru console logging.

8. Your application is now successfully deployed on Fly. We suggest that you keep at least 1 machine running all the time to constantly listen for new requests to your agent. You can do this by adjusting your fly.toml file that was generated by Fly when you ran `fly launch`. 

You should see a section like this:
```
[http_service]
  internal_port = 8000
  force_https = true
  auto_stop_machines = true
  auto_start_machines = true
  min_machines_running = 0
  processes = ["app"]
```

You want to have these settings:
```
auto_stop_machines = false
auto_start_machines = true
min_machines_running = 1
```

This way, your agent will always be running and won't miss any requests from users.

It is also important that your internal_port for the http-service is set to your agent's port. As in, it should be set to whatever value is set for AGENT_PORT in your .env file.

Note that you (or anyone else) will not be able to just create a POST request and try to use your agent by hitting your hosted API because we are using localhost for everything.

You can now run `fly deploy` and your application will be live.
