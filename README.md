# SilenceCut Studio

A professional client-side audio post-production web app built with React. Features intelligent silence removal, broadcast-quality voice enhancement (noise gating, EQ, compression), and instant MP3/WAV export—all processed locally in the browser.

## Features

*   **🚫 Smart Silence Removal:** Automatically detects and removes dead air with customizable intensity (70%, 80%, 100%) and safety padding to keep words intact.
*   **🎙️ Studio Voice Enhance:** "Adobe Podcast" style DSP chain featuring dual-stage de-essing, proximity bass boost, and broadcast compression.
*   **🔒 100% Client-Side:** All processing happens in the browser using the Web Audio API. No files are ever uploaded to a server.
*   **📊 Visual Feedback:** Real-time waveform visualization showing exactly where cuts happen.
*   **💾 Multi-Format Export:** Instant export to WAV or MP3 (via LAMEjs).

## How to Run Locally

1.  **Install Node.js**: Ensure you have Node.js installed (v16 or higher).
2.  **Install Dependencies**:
    ```bash
    npm install
    ```
3.  **Start Development Server**:
    ```bash
    npm run dev
    ```
4.  **Open in Browser**: Navigate to `http://localhost:5173`.

## How to Deploy (Free)

You can deploy this project for free using **Vercel** or **Netlify**.

1.  Push this code to a GitHub repository.
2.  Login to Vercel/Netlify and "Add New Project".
3.  Select your repository.
4.  The build settings should be detected automatically (Framework: Vite).
5.  Click **Deploy**.

## Tech Stack

*   React
*   TypeScript
*   Tailwind CSS
*   Vite
*   Web Audio API (OfflineAudioContext)
*   LAMEjs (for MP3 encoding)
