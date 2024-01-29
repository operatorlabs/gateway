
import dotenv from "dotenv";
import { Client } from "@xmtp/xmtp-js";
import axios from "axios";

dotenv.config();

let client;

const agent_endpoint = process.env.AGENT_ENDPOINT;
const agent_port = process.env.AGENT_PORT;
// url should be set to localhost for supervisord based deploy
const url = `http://localhost:${agent_port}/${agent_endpoint}`;

if (process.env.XMTP_KEY) {
  const envKeyBundle = Buffer.from(process.env.XMTP_KEY, "base64");
  Client.create(null, {
    env: "production",
    privateKeyOverride: envKeyBundle,
  })
    .then(async (createdClient) => {
      client = createdClient;
      console.log("Successfully generated client from environment variable.");

      // Use streamAllMessages to monitor all incoming messages
      for await (const message of await client.conversations.streamAllMessages()) {
        console.log(`New message from ${message.senderAddress}: ${message.content}`);
        if (message.senderAddress.toLowerCase() != client.address.toLowerCase()) {
          
          const data = {
            message: message.content,
          };

          try {
            const response = await axios.post(url, data, {
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "Sender": message.senderAddress.toLowerCase()
              },
            });
            console.log(response.data);
            const sent = await message.conversation.send(response.data.message);
          } catch (error) {
            if (error.response && error.response.status === 400) {
              // 400 error should have data.detail field
              await message.conversation.send(`Error: ${error.response.data.detail}`);
            } else {
              // General error message
              await message.conversation.send(`Error: ${error.message}`);
            }
          }
        }
      }
    })
    .catch((error) => {
      console.error("Error creating client:", error);
    });
} else {
  console.error("XMTP_KEY not found in environment variables");
}

// Close the stream when the service is stopped
process.on("SIGINT", () => {
  process.exit(0);
});