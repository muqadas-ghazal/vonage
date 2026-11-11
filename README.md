# Booth

A Next.js video room powered by the Vonage Video API. Two people open the same room URL in separate browsers and join one call.

## Setup

1. In the [Vonage dashboard](https://dashboard.vonage.com/), open your video project and copy the project API key and project secret.
2. Put them in `.env`:

```
PROJECT_API_KEY=your-project-api-key
PROJECT_SECRET=your-project-secret
```

3. Start the app:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Restart the dev server after changing `.env.local`.

## Make a call

1. Enter your name and a room name, then open the room.
2. Copy the room link.
3. Open that link in a second browser (or on another device) and enter the other person's name.

Both browsers join the same Vonage session. Before a frame is sent, this app encrypts the audio and video with AES-CTR in the browser. The other browser decrypts those frames before they are played. Vonage only carries the encrypted media. The key is the `#k=` part of the room link, so copy that full link. It is not sent to the app server. After this cipher changes, reload both browsers and copy the room link again.

A laptop often allows only one browser to use the camera at a time. Use two devices, or a second camera, when you want video on both sides. The browser that cannot get the camera can still watch and listen.

Room names are remembered in `data/sessions.json` so both browsers attach to the same session. That file is local to this server process and is not a substitute for a database if you deploy more than one instance.

## Deploying to Vercel

1. Push the repo and import it in Vercel. The build command is the default `npm run build`,
   which builds the `@booth/frame-cipher` workspace first and then the app.
2. Set **`PROJECT_API_KEY`** and **`PROJECT_SECRET`** from the Vonage dashboard.
3. Add a **Vercel KV** (or Upstash Redis) integration. This is not optional: rooms are a
   mapping from room name to Vonage session id, and every instance must read the same one.
   Without it the filesystem store throws on Vercel's read-only disk, and even if it did
   not, two people in one room would be put in two different calls.

`/api/health` reports what is missing, and the lobby shows it, so a misconfigured deploy
says so on the first page load rather than at the first join.

Nothing about encryption needs configuring: keys are generated in the browser and never
reach the server.
