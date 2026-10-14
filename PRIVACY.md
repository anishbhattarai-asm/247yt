# Privacy policy: Stream Panel

Stream Panel is self-hosted software: each copy runs on its owner's own
server and is used only by that owner. There is no central service, no
analytics and no third party receiving data from it.

## What the YouTube connection is used for

If the owner chooses **Connect YouTube**, the panel asks Google for access to
the owner's YouTube account (scope `https://www.googleapis.com/auth/youtube`)
and uses it only to:

- read the owner's own live streams and broadcasts, and YouTube's health
  report for the stream the panel sends;
- create a broadcast for the owner's stream, change its Auto-stop setting,
  and bind it to the owner's stream key when the owner asks, or replace a
  broadcast that YouTube ended while the panel was streaming;
- show the channel name in the panel.

It does not read or change videos, comments, subscribers, playlists or any
other account data, and it does not access any other Google service.

## What is stored, and where

The sign-in token, the channel name and ID, and the broadcast ID are stored in
the panel's settings file on the owner's server (file permissions 600). They
are never sent anywhere except to Google's own APIs. YouTube data is only
shown in the owner's panel and, for stream-health alerts, in the owner's own
Discord channel if the owner set one up.

## Removing access

Press **Disconnect** in the panel (this revokes the token with Google), or
remove "Stream Panel" at https://myaccount.google.com/permissions. Deleting the
panel's `data/` folder removes everything it stored.

## Contact

The support email shown on Google's consent screen for this app, or an issue
in this repository.
