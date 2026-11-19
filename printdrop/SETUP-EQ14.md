# Setting up PrintDrop on the Beelink EQ14

From the box arriving to people printing. Set aside about an hour. Most of
that is waiting for downloads.

You'll need, for the first hour only:

- a monitor with HDMI, a USB keyboard and a network cable
- a USB stick of 8 GB or more (it gets erased)
- your Mac

## Before it arrives

1. **Check that the office network can reach the printer.** On your Mac, open
   `http://<the address on the Ricoh's screen>` in a browser (Check Status →
   Machine Status → Network → IPv4 Address). If the Ricoh's own web page
   loads, the EQ14 will be able to reach it directly. If it doesn't load,
   that's fine too. PrintDrop will use the address on the wall sheet instead.

2. **Ask the building's IT for two things:**
   - permission to plug a small server into the network, ideally a wired
     port near the printer. Many office networks block devices that aren't
     registered.
   - a **reserved IP address** for it, so the address on the sign by the
     printer never changes. They'll want the EQ14's MAC address; step 6
     below shows how to find it.

3. **Make the Ubuntu USB stick** on your Mac:
   - Download **Ubuntu Server 24.04 LTS** from
     <https://ubuntu.com/download/server>. It's a single `.iso` file.
   - Download **balenaEtcher** from <https://etcher.balena.io> and open it.
   - Choose the `.iso`, choose the USB stick, click **Flash**.

## 1. Plug it in

Connect the monitor (HDMI), the keyboard, a network cable into either network
port, and the power cord. The EQ14's power supply is built in, so it's one
ordinary cord. Plug in the USB stick.

## 2. Tell it to come back on after a power cut

Turn it on and **tap Delete** repeatedly until the setup screen (BIOS)
appears. Look for a setting named like **State After G3** or **Restore on AC
Power Loss**. On these machines it's usually under *Chipset → PCH-IO
Configuration*. Set it to **S0 / Power On**. Press **F4** to save and exit.

This way the machine starts up again by itself after a power outage, and
PrintDrop with it.

## 3. Install Ubuntu (wipes Windows)

As it restarts, **tap F7** to get the boot menu and pick the USB stick
(choose the "UEFI" entry if there are two). Then choose **Try or Install
Ubuntu Server** and work through the installer:

| Screen | Choose |
|---|---|
| Language / keyboard | English (US) |
| Type of install | **Ubuntu Server** (not "minimized") |
| Network | It should show an address on the port you plugged in. Note it down. |
| Proxy / mirror | Leave as they are |
| Storage | **Use an entire disk**. Accept that Windows is erased. |
| Profile | Your name; server name **`printdrop`**; a username and password you'll remember |
| Ubuntu Pro | Skip for now |
| SSH | ✅ **Install OpenSSH server** |
| Featured snaps | Pick **nothing**, not even Docker. It gets installed properly below. |

When it says **Installation complete**, choose **Reboot now**, and pull out the
USB stick when asked.

## 4. Log in from your Mac

From here on you can work from your Mac. Open **Terminal** on the Mac and type
(with the username you picked):

```sh
ssh yourname@printdrop.local
```

If `printdrop.local` doesn't work, use the address you noted during the
install. To see the address on the EQ14 itself, log in there and type
`hostname -I`.

Type `yes` the first time it asks about the fingerprint, then your password.

## 5. Install Docker and PrintDrop

Paste these one block at a time.

Make `printdrop.local` work on the network and install Docker:

```sh
sudo apt update && sudo apt install -y avahi-daemon
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
exit
```

That last line logs you out. Log back in (`ssh yourname@printdrop.local`)
so the Docker permission takes effect.

Download PrintDrop:

```sh
git clone -b claude/kind-sagan-9ff996 https://github.com/herman551/soundsociety-site.git
cd soundsociety-site/printdrop
cp .env.example .env
nano .env
```

In the editor, change the `PRINTER=` line to the two addresses: first the one
on the Ricoh's screen, then the one on the wall sheet with its queue name:

```
PRINTER=<address on the Ricoh's screen> lpd://<address on the wall sheet>/<queue name on the wall sheet>
```

Save with **Ctrl+O**, **Enter**, then leave with **Ctrl+X**.

Start it. The first time takes about 10 minutes while it downloads
everything:

```sh
docker compose up -d --build
docker compose logs printdrop | grep -i printer
```

You want to see a line like **`Printer answers at socket://…`** or
**`… at lpd://…`**. That's the address it will print to.

## 6. Try it

On your Mac, open **`http://printdrop.local`** (or `http://<its address>`).

1. Drop in any PDF, tap **Letter**, press **Print**. It should come out of
   Tray 1 or 2.
2. Drop in a 13 × 10 file. It goes to the bypass tray and waits under
   *Waiting for paper*. Load 13 × 10 paper in the bypass tray (10-inch edge
   going in first), slide the guides against it, and tap **Paper's loaded,
   print now**.
3. Open **`http://printdrop.local/sign`** and print the sign for the wall.

To find the MAC address IT asked for, run this on the EQ14 and use the
`link/ether` value of the port you plugged in:

```sh
ip link
```

Once IT has reserved an address, put it on the sign by adding this line to
`.env`, then run `docker compose up -d`:

```
PRINTDROP_PUBLIC_URL=http://<reserved address>
```

## 7. Make sure it survives a restart

```sh
sudo reboot
```

Wait a minute and reload the page. It should come back by itself. Docker
starts at boot, and PrintDrop restarts with it.

You can now unplug the monitor and keyboard and put the box wherever it
lives.

## Looking after it

All of these are run from `~/soundsociety-site/printdrop` on the EQ14 (log in
with `ssh` first).

| To... | Run |
|---|---|
| Change trays, paper sizes or presets | `nano config/printdrop.yml`, then `docker compose restart` |
| See what it's doing | `docker compose logs --tail 50 printdrop` |
| Check which printer addresses answer | `docker compose exec printdrop python3 -m printdrop probe <address>` |
| Update PrintDrop | `git pull && docker compose up -d --build` |
| Restart it | `docker compose restart` |

Ubuntu installs security updates by itself. Once a month or so, run
`sudo apt update && sudo apt upgrade -y` for the rest.

## If something goes wrong

**The page loads, but jobs say "Can't reach the printer".** Neither address in
`PRINTER=` is answering from the EQ14. Run the probe command above with each
address. If nothing answers, the EQ14 is on a part of the network that
can't see the printer. Ask IT, or move it to a port near the printer.

**`docker compose up` fails with "toomanyrequests".** Docker Hub limits
downloads per office internet connection. Make a free account at
<https://hub.docker.com>, run `docker login`, and try again.

**Downloads fail with certificate errors.** The office network is inspecting
secure traffic. IT will need to let the EQ14 through or give you their
certificate.

**Bypass jobs still stop and ask about paper on the Ricoh's screen.** Ask
whoever manages the copier to set **Bypass Tray Setting Priority** to
**Driver / Command**. Until then, pick the size and type PrintDrop showed you
on the Ricoh's screen and continue (**Form Feed** on most Ricohs).

**Windows says it can't open the drop folders.** Windows won't use guest
access. Sign in with the `SMB_USER` / `SMB_PASSWORD` from `.env` (default
`print` / `print`).

**`printdrop.local` doesn't work on some computers.** Some office networks
block these names. Use the address instead, ideally the reserved one.
