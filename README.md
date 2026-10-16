# Clicker Show — Host

The presenter app: project dashboard, media library, slide editor, HDMI presentation, and a phone remote. It works together with the separate **Clicker Show — Join** app that players open on their phones.

The interface is in English. Everything you type (questions, answers, project and team names) is written and displayed right-to-left, for Yiddish.

## Publish on GitHub Pages

All files sit side by side in one folder (there are no subfolders), so nothing gets lost when you upload.

1. Unzip `clicker-host.zip` on your computer.
2. On GitHub, open your repository (for example `clicker-host`) → **Add file → Upload files**.
3. Open the unzipped folder, select **every file** (Ctrl+A on Windows, Cmd+A on Mac), and drag them all into the GitHub upload box. You should see about 30 files listed. Then press **Commit changes**.
4. Go to **Settings → Pages**. Under "Build and deployment", choose **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**.
5. Wait a minute, then open `https://YOUR-USERNAME.github.io/clicker-host/`.

If a file is missing, the page shows which files to upload instead of staying blank.

6. Publish the Join app the same way in its own repository.
7. Open the Host app. In **Join app address** at the top of the dashboard, paste the Join app's address (for example `https://YOUR-USERNAME.github.io/clicker-join/`) and press **Save**. The QR codes on screen point there.

**Optional:** to pre-fill the address for anyone who opens your Host app, put it in `config.js` (`DEFAULT_JOIN_URL`). Your dashboard setting always takes priority over it.

**Custom domain:** in Settings → Pages you can set a domain such as `host.yourdomain.com`. Use a different domain or subdomain for the Join app.

## Sync your host devices

You can use the Host app on several computers and phones. They keep each other up to date automatically.

1. **Create the group.** On one device, open the dashboard. Under **Device sync**, press **Create a sync group**.
2. **Add your other devices.** Press **Add a device** and scan the QR code with the other phone or computer. You can also open the Host app there and type the 12-letter code.
3. **You're done.** All projects, music, sound effects and the Join app address now copy to every device in the group.
   - Edits, new uploads and deletions show up on the others within seconds.
   - Each device saves its own full copy, so it keeps working even when the others are off.
   - A device that was offline catches up the next time it opens the app.

**Controlling a running show from any device:** while a show is running, every synced device shows it under **Live now** on the dashboard. Press **Control this show** to turn that device into the remote. On a phone you can also open `remote.html` from the Host site to get a list of running shows.

**How it works:**
- Devices connect directly to each other over WebRTC, the same way players connect to a show. Nothing is stored on any server.
- One device acts as the meeting point, and if it closes, another takes over automatically.
- The code never leaves your devices. They prove to each other that they know it before sharing anything.

**Keep the code private:** anyone with the code gets a copy of your projects. Only add your own devices. To stop syncing a device, press **Leave**.

**When devices sync:** a device syncs only while the Host app is open on it.

## Running a show

1. **Create a project.** Use the "+" card on the dashboard. Upload music, sound effects and intro videos once in the **Media library**; every project can use them.
2. **Set up the event.** In the editor's Event settings, choose:
   - The teams.
   - **Join screen music**, which plays automatically while people join.
   - Whether voting opens by itself when a question finishes typing.
   - Whether the answer is revealed by itself when time runs out.
3. **Make the intro.** It's the **Intro** item at the top of the show order:
   - **Text & music:** a title, a message for the occasion and an intro track, plus optional "How to play" steps.
   - **Video:** upload an MP4. It plays full screen with its own sound.
   - **No intro:** skip it.
4. **Write the questions.** For each one, set:
   - Quiz or survey.
   - The question and 1–5 answers, and which answer is correct.
   - The timer.
   - **Music while voting:** the built-in ticking countdown, silence, or one of your tracks. Choose whether it starts automatically.
   - Which result steps follow the question.

### Just press Next

During the show you only need **Next** (→ key, presenter clicker, or the big button on the phone remote). The console and the remote always say what Next will do. Each press does one step:

1. **Join screen** (join music plays) → Next **closes joining** and starts the intro.
2. **Intro** (text + music, or video) → Next starts question 1.
3. **The question types onto the screen.** Voting opens automatically, or press Next to open it right away.
4. **Voting** (countdown music plays):
   - Names fly up as people answer, but **nobody can see what they chose or which team they're on**.
   - When time runs out, the screen shows "Time's up!".
   - Pressing Next before then stops the countdown early.
5. **Reveal:** the correct answer lights up with percentages, and the reveal sound plays.
6. **Team results:** each team's answers and the round winner.
7. **Fastest players:** the top 10 fastest correct answers.
8. **Next question.** After the last one comes the **final results**.

**Previous** goes back one step.

**Manual controls** (in the console panel and on the remote) are still there if you want to take over:
- Pause the timer or reopen voting.
- Close voting, reveal, or skip the typing.
- Jump to the intro or the join screen.
- **Let late players join**: new players can't join after the join screen until you press this.

**Music** (the button or B):
- Turns the music for the current step on or off.
- On a question whose track isn't set to start automatically, it starts that track.
- On other steps, it plays the join-screen music.

### Keyboard

| Key | Action |
|---|---|
| → / PageDown | Next |
| ← / PageUp | Previous |
| Space | Open voting / pause / resume |
| S | Skip typing |
| L | Close voting |
| R | Reveal |
| I | Intro |
| J | Join screen |
| M | Mute |
| B | Music on/off |
| F | Fullscreen |
| 1 | Player count overlay |
| 2 | Percentages (only after voting closes) |
| 3 | Team split (only after voting closes) |
| 4 | Top 10 fastest (only after voting closes) |

The arrow and PageUp/PageDown keys also work in the display window, so a presenter clicker works there.

**Sound after a reload:** browsers only allow sound after you click or press a key. If you reload the console, click the "Click to turn on sound" button once.

### Resilience
- If the host page reloads, the session comes back with the same code, players and answers.
- Results can be exported as a CSV file.

## Good to know
- **Connections:** phones connect directly to the host computer using WebRTC. A free public server (PeerJS) only introduces the devices to each other; the answers don't pass through it.
- **Venue networks:** direct connections work on most Wi-Fi and mobile networks. Some strict corporate networks block them, so test at the venue first. If some phones can't connect, a TURN server can be added in `ICE_SERVERS` in `protocol.js`.
- **Number of players:** about 150–250 players is a realistic limit for one host computer.
- **Keep the console open:** don't minimize the console window during the show, because browsers slow down hidden windows. Put the display window on the second screen instead.
- **Compatibility:** the Host and Join apps share `protocol.js`. If you change one copy, update both.
- **Intro videos:** MP4 (H.264) plays in Chrome, Edge and Safari. Videos are copied to your synced devices too, so large videos take a while to arrive.
- **Reveal sound:** the built-in reveal sound is `reveal.mp3`. To change it, choose your own file under Event settings → Sound effects.
- **First load needs internet:** the first time, the app downloads PeerJS, the QR library and fonts. After that they are cached.
