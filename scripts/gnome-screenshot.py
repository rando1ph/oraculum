"""Capture GNOME's real desktop using its existing Shift+Print shortcut.

Requires the user's existing /dev/uinput access; changes no desktop settings.
Only the unambiguously new screenshot generated here is copied and removed.
--show-notifications toggles GNOME's standard Super+V notification panel.
--show-desktop toggles GNOME's standard Super+D desktop view.
"""
import os, struct, fcntl, time, pathlib, subprocess, shutil, sys
panel = sys.argv[1] == '--show-notifications'
desktop = sys.argv[1] == '--show-desktop'
folder = pathlib.Path(subprocess.check_output(['xdg-user-dir','PICTURES'], text=True).strip()) / 'Screenshots'
before = set(folder.glob('*.png'))
fd = os.open('/dev/uinput', os.O_WRONLY | os.O_NONBLOCK)
try:
    fcntl.ioctl(fd, 0x40045564, 1)
    fcntl.ioctl(fd, 0x40045564, 0)
    for key in [42,99,125,47,32]: fcntl.ioctl(fd, 0x40045565, key)
    os.write(fd, struct.pack('80sHHHHI' + 'i'*256, b'Oraculum B7 screenshot',3,1,1,1,0,*([0]*256)))
    fcntl.ioctl(fd, 0x5501)
    time.sleep(0.3)
    key = 47 if panel else 32
    keys = [(125,1),(key,1),(key,0),(125,0)] if panel or desktop else [(42,1),(99,1),(99,0),(42,0)]
    for code,value in keys:
        os.write(fd, struct.pack('llHHi',0,0,1,code,value))
        os.write(fd, struct.pack('llHHi',0,0,0,0,0))
        time.sleep(0.05)
    if panel or desktop: sys.exit(0)
    for _ in range(50):
        files = set(folder.glob('*.png')) - before
        if len(files)==1:
            path = next(iter(files))
            if path.stat().st_size > 0:
                shutil.copyfile(path,sys.argv[1]);path.unlink();print(sys.argv[1]);break
        time.sleep(0.1)
    else: raise RuntimeError('No unambiguous new GNOME screenshot')
finally:
    fcntl.ioctl(fd, 0x5502);os.close(fd)
