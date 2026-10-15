#!/bin/sh
# Shell for rig sandboxes (macOS): bash under sandbox-exec with the rig profile.
exec /usr/bin/sandbox-exec -f "$RIG_PROFILE" -D WS="$RIG_WS" -D HM="$RIG_HOME" /bin/bash "$@"
