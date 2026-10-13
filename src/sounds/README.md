# Message sounds

Every sound file in this folder is built into the app. One is picked at random each time a message arrives or is sent.

- **Formats**: `.mp3`, `.wav` or `.m4a`. All three play in every browser the app supports. Avoid `.ogg`, which older iPhones cannot play.
- **Length**: short, ideally under two seconds, with no silence at the start (the sound should begin the moment a message lands).
- **Loudness**: about the same across all of them, peaking around −3 dB.
- **Size**: every file is downloaded the first time a sound is needed, so keep the whole folder under about half a megabyte. Mono is fine.

To change the set, add or remove files here and deploy. The `placeholder-*.wav` files are stand-ins and can be deleted once real sounds are in.
