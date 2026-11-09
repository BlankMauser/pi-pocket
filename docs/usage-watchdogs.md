# Usage watchdogs

[View and stop](#view-and-stop) · [Host setup](#host-setup)

## View and stop

The owner opens **Menu → Usage watchdogs**, or the same button in **Subscription usage**. Each row shows its session, provider, last decision and next check in the device’s time zone. **Stop watchdog** writes the existing durable stop marker and disables the timer. It does not stop the agent or change its model. This screen cannot create or restart a watchdog.

The screen refreshes every 15 seconds while visible. A failed check shows **unknown**, with any previous result labeled as last known. Historical stopped timers remain inspectable.

## Host setup

The optional Linux bridge controls only the existing hosted `usage_watchdog.py` installation. Keep both scripts root-owned. Other hosts show that controls are unavailable.

<details>
<summary>Install the bridge on the MatchaMill host</summary>

```bash
sudo install -o root -g root -m 0644 contrib/usage-watchdog-control.py /opt/matchamill/pi-pocket/usage-watchdog/control.py
sudo tee /etc/sudoers.d/matchamill-pocket-watchdogs >/dev/null <<'POLICY'
matchamill-pocket ALL=(root) NOPASSWD: /usr/bin/python3 -I /opt/matchamill/pi-pocket/usage-watchdog/control.py status, /usr/bin/python3 -I /opt/matchamill/pi-pocket/usage-watchdog/control.py stop *
POLICY
sudo chmod 0440 /etc/sudoers.d/matchamill-pocket-watchdogs
sudo visudo -cf /etc/sudoers.d/matchamill-pocket-watchdogs
sudo -u matchamill-pocket sudo -n /usr/bin/python3 -I /opt/matchamill/pi-pocket/usage-watchdog/control.py status
```

The bridge anchors all state access to validated directory descriptors, rejects symlinks and nonregular or untrusted files, and flushes the stop marker before disabling the timer and stopping an in-flight check. It never delegates privileged file writes to the legacy helper.

The bridge accepts only `status` or `stop` with one positive safe integer. Python runs isolated (`-I`), without user-controlled import paths. HTTP routes require owner authentication; Stop also requires Pocket’s mutation header. The bridge executes fixed commands without a shell and returns only status metadata.

</details>
