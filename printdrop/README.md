# PrintDrop

A small print server for one hard-to-print-to office copier (a Ricoh IM C3510).
Anyone on the network opens a web page, drops a file in, taps a paper size
and presses Print. No drivers, IP addresses or queue names on anyone's
computer. PrintDrop handles the Ricoh.

It is built around the bypass tray, which is where most printing to this
machine goes wrong:

- **Bypass jobs wait for you.** A job for the bypass tray isn't sent until
  you're at the printer, have loaded the paper, and tap **Print now**, on your
  phone or computer. Nothing reaches the Ricoh while the tray is empty or
  holds someone else's paper, so it can't stall the printer for everyone else.
- **It tells you what to load:** paper size, paper type, and for custom sizes
  which edge goes in first.
- **13 × 10 works.** The Ricoh's bypass tray is at most 12.6″ wide, so 13 × 10
  has to feed 10″ edge first. PrintDrop sends it as a 10 × 13 custom page and
  rotates landscape artwork onto it. A 13 × 10 PDF is recognized
  automatically.
- **Automatic routing.** Sizes no drawer holds (13 × 10, 12 × 18,
  envelopes...) and special paper (cardstock, labels...) go to the bypass tray
  on their own. Letter, Legal and 11 × 17 come from the drawers.

Also:

- **Drop folders.** An optional network share with one folder per preset
  (`Bypass - 13x10`, `Tabloid 11x17`, ...). Save a file into a folder and it
  prints with that folder's settings.
- **Takes what people have.** PDF, Word, Excel, PowerPoint, images and text.
  A4 documents print on Letter instead of waiting for A4 paper.
- **Locked Print.** An optional PIN holds a private job on the Ricoh until
  you type the PIN on its screen.
- **Status for everyone.** The page shows whether the printer can be reached
  and, if the Ricoh allows it, paper jams, empty trays and toner levels.
- **A printable sign** for the wall at `/sign`, with a QR code.
- **It stays up.** The print queue switches itself back on if anything turns
  it off. A printer that can't be reached is retried, not given up on.

## What you need

- A small always-on computer **on the same network as the printer**: a
  Raspberry Pi 4 or 5 (64-bit Raspberry Pi OS), an old PC, or a mini PC
  running Linux. About 2 GB of disk.
- Docker on it: `curl -fsSL https://get.docker.com | sh`

> If your network needs devices to be registered before they get an address,
> register the box first.

## Set up

```sh
git clone <this repository> printdrop
cd printdrop/printdrop      # the folder with docker-compose.yml
cp .env.example .env
nano .env                   # set PRINTER (see below)
docker compose up -d --build
```

Then open `http://<the box's address>/` from any computer on the network.
Open `/sign`, print it, and stick it on the printer.

To give the box a friendly name, set its hostname to `printdrop`. Most Macs,
iPhones and Windows PCs will then reach it at `http://printdrop.local/`.
Some office networks block `.local` names; the IP address always works.

### Telling PrintDrop where the printer is

The Ricoh shows its own address on its screen: **Check Status → Machine
Status → Network → IPv4 Address**.

The instructions sheet by a printer often lists a *different* address,
sometimes a print server, or an old address from before the copier was
replaced. You can list both. PrintDrop tries them in order and uses the first
that answers:

```sh
# .env
PRINTER=<address on the Ricoh's screen> lpd://<address on the sheet>/<queue name on the sheet>
```

A bare address means "work out how to talk to it" (raw port 9100, then LPD,
then IPP). A full `lpd://` or `socket://` address is used exactly as written.

To check what the box can reach:

```sh
docker compose exec printdrop python3 -m printdrop probe <printer address>
```

`docker compose logs printdrop` shows which address it picked at startup.

### Settings

`config/printdrop.yml` holds everything about the printer that isn't an
address: what's loaded in each drawer, the paper sizes and types in the
menus, the one-tap presets (each preset is also a drop folder), and how
bypass jobs behave. Edit it, then run `docker compose restart`.

The drawers are set up as Tray 1 & 2 Letter, Tray 3 Legal, Tray 4 11 × 17,
matching the printer's screen. Change `paper:` when someone reloads a drawer
with something else.

### Drop folders (optional)

With `SMB_ENABLED=1`, the folders are shared as `PrintDrop`:

- Mac: Finder → Go → Connect to Server → `smb://printdrop.local/PrintDrop`
- Windows: File Explorer address bar → `\\printdrop\PrintDrop`

Windows 10/11 won't open guest shares, so they'll ask for a login. Use
`SMB_USER` / `SMB_PASSWORD` from `.env` (default `print` / `print`).

Files that can't be printed move to `_Could not print`, with a note saying why.
Bypass-tray folders still wait for **Print now** on the web page.

## One setting on the Ricoh worth checking

Ricoh copiers can be set to ignore the paper size a job asks for in the
bypass tray and use whatever was last chosen on the copier's own screen.
That causes constant "paper mismatch" prompts. If bypass jobs keep stopping
to ask about the paper, have whoever manages the copier set **Bypass Tray
Setting Priority** to **Driver / Command**. The exact menu path varies by
firmware; it's under the printer or tray/paper settings.

If the screen does ask, pick the size and type PrintDrop showed you and
continue (on most Ricohs, **Form Feed**). **Job Reset** cancels the job.

## Good to know

- There's no login. Anyone who can open the page can print, see file names
  in the job list, and cancel jobs. That suits a shared office printer. Don't
  expose PrintDrop to the internet.
- Uploaded files are kept for 24 hours so people can reprint them, then
  deleted. PIN jobs are deleted as soon as they reach the printer.
- The Ricoh's job list shows the first 8 letters of the name people type in.
- One-page jobs always print 1-sided, even when 2-sided is picked.
- Port 445 (drop folders) clashes with macOS File Sharing. Run PrintDrop on
  Linux, or turn off SMB_ENABLED on a Mac.
- The office Macs are set up with the IM C3500 driver and "Finisher SR3260".
  PrintDrop uses the IM C3510's own driver (`ppd/`). If the machine really
  has a stapler, set `Finisher` in `config/printdrop.yml`.

## How it works

```
browser / drop folder
        │
   PrintDrop (Python, FastAPI)      converts Office/images to PDF, matches
        │                           the page size, picks the tray, holds
        │                           bypass jobs until released
   CUPS + Ricoh's PPD               turns the job into PostScript with the
        │                           Ricoh's own tray/paper commands
   Ricoh IM C3510 (port 9100/LPD/IPP)
```

Everything runs in one container: CUPS (only reachable inside the
container), the web app on port 8080 (published as 80), and Samba on 445.

## Development

```sh
sudo apt install cups cups-filters ghostscript poppler-utils python3-cups \
  python3-fastapi python3-uvicorn python3-multipart python3-yaml python3-pil \
  python3-qrcode python3-pytest python3-httpx
python3 -m pytest tests/test_units.py     # quick, no CUPS needed
sudo python3 -m pytest tests/             # end to end: real CUPS and the Ricoh
                                          # driver, printing to fake printers
```

The end-to-end tests send real jobs through CUPS and the Ricoh driver to fake
raw-socket and LPD printers (`tests/fake_printer.py`). Then they read the
PostScript back to check the tray, paper size, paper type, color, sides,
copies, user name and PIN the Ricoh would receive.

Run it locally without Docker:

```sh
PRINTER=socket://127.0.0.1:9101 PRINTDROP_DATA=./data sudo -E python3 -m printdrop setup
PRINTER=socket://127.0.0.1:9101 PRINTDROP_DATA=./data python3 -m printdrop
```
