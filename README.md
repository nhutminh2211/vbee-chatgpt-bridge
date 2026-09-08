# Vbee ChatGPT Bridge

Secure bridge between ChatGPT Actions, Vbee asynchronous TTS, and Remotion.

## Required Render environment variables

- `VBEE_APP_ID`: Vbee application ID.
- `VBEE_TOKEN`: Vbee bearer token. Store only as a Render secret.
- `BRIDGE_API_KEY`: Random secret used by the Custom GPT Action.
- `CALLBACK_SECRET`: Random secret embedded in the Vbee callback URL.
- `AUDIO_SIGNING_SECRET`: Random secret used to sign temporary Remotion-compatible audio URLs.
- `PUBLIC_BASE_URL`: Optional explicit Render service URL.

## Endpoints

- `GET /health`
- `GET /v1/voices`
- `POST /v1/speech`
- `GET /v1/speech/:requestId`
- `GET /v1/audio/:requestId?expires=...&signature=...`
- `POST /v1/callback/:secret`

## Custom GPT setup

1. Replace `REPLACE_WITH_RENDER_SERVICE_URL` in `openapi.yaml`.
2. In the GPT editor, add a new Action and paste the OpenAPI schema.
3. Choose API key authentication, Bearer, and enter the same value as `BRIDGE_API_KEY`.
4. Instruct the GPT to create speech, poll status until `COMPLETED`, then return `audioUrl` for Remotion.
