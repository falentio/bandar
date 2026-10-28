# Running bandar as a systemd service

`bandar install-service` writes a systemd unit for the binary that runs it, then prints the
commands that enable and start it. The command never runs `systemctl` itself, so it stays safe on
a machine with no manager of its own, and the file it writes is the whole effect.

## Install

```sh
bandar install-service                        # ~/.config/systemd/user/bandar.service
sudo bandar install-service --scope system    # /etc/systemd/system/bandar.service
```

The commands to run next are the last four lines on stdout, one per line:

```sh
systemctl --user daemon-reload
systemctl --user enable bandar.service
systemctl --user start bandar.service
systemctl --user status bandar.service
```

`--scope system` prints the same four without `--user`. Everything else the command learns goes to
stderr: which files it wrote, and which ones it kept.

| flag         | default                                                              |
| ------------ | -------------------------------------------------------------------- |
| `--scope`    | `user`                                                               |
| `--data-dir` | `~/.local/share/bandar` for user scope, `/var/lib/bandar` for system |
| `--port`     | none: the unit pins no port, and `serve` reads `config.json`         |
| `--binary`   | the executable running the command                                   |

The data directory comes from `--data-dir`, else `XDG_DATA_HOME` or `~/.local/share/bandar` for
user scope and `/var/lib/bandar` for system scope. The unit pins a port only when `--port` names
one, so a port in `config.json` is picked up on the next start. A `BANDAR_PORT` in the shell is not
written into the unit; `serve` reads it at start, where it still wins over the file.

## What the unit holds

```ini
[Unit]
Description=bandar, a self-hosted LLM gateway
Documentation=https://github.com/falentio/bandar
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/home/andrew/.local/bin/bandar serve
WorkingDirectory=/home/andrew/.local/share/bandar
Environment=BANDAR_HOME=/home/andrew/.local/share/bandar
EnvironmentFile=-/home/andrew/.config/bandar/bandar.env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

The unit points the binary at its data directory through `BANDAR_HOME`, so the databases land there
whatever directory systemd happens to start in, and `--data-dir` moves both files with the unit.
`config.json` sits in that same directory: the service reads `<data dir>/config.json`, and the
install prints the path it will read.

The install creates every directory the unit names: the unit directory, the data directory, and
the config directory that holds the env file. `WorkingDirectory=` is not optional to systemd — a
missing directory fails the start with a CHDIR error, which `Restart=on-failure` would repeat
every five seconds — so the data directory exists before the unit does.

A system unit adds `User=` and `StateDirectory=bandar`, and starts at `multi-user.target`.
`User=` is the account that ran `sudo`, so the service does not run as root. `StateDirectory`
makes systemd create `/var/lib/bandar` for that account; when `--data-dir` points somewhere else,
the install creates it as the account that ran `sudo`, so `chown` it to the service account before
starting the unit.

## The environment file

The unit reads `<config dir>/bandar.env` through `EnvironmentFile=-`, which tolerates a missing
file. The config directory is `BANDAR_CONFIG_DIR`, defaulting to `~/.config/bandar`.

The first install writes the file with mode 600 and one generated `BANDAR_AUTH_SECRET`. The unit
itself stays world-readable at mode 644, so the session secret never goes in it. An existing env
file is never overwritten: to rotate the secret, edit the file and restart the service. Settings in
this file are read after the unit's `Environment=` lines, so they win, `BANDAR_PORT` included.

## Uninstall

```sh
bandar uninstall-service                        # keeps the data and the env file
bandar uninstall-service --purge                # removes both
sudo bandar uninstall-service --scope system
```

The command deletes the unit file and prints:

```sh
systemctl --user disable --now bandar.service
systemctl --user daemon-reload
```

The data directory and the env file stay behind unless `--purge` is passed. `--purge` removes both
and refuses the filesystem root and the home directory, so a mistyped `--data-dir` cannot wipe
either.

## Notes

- On `--scope system` without root, both commands print the `sudo` invocation that would work and
  exit 1 without writing anything.
- `--binary` is for a checkout: under `bun src/server/main.ts` the running executable is Bun, not
  bandar, and the unit has to point at the compiled binary or the release download.
- systemd is Linux-only. The command renders the same files on other platforms, but nothing reads
  them there.
