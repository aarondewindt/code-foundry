"""Two synthetic writers used to verify whole-container termination."""

import argparse
from pathlib import Path
import subprocess
import sys
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('root', type=Path)
parser.add_argument('--child', action='store_true')
args = parser.parse_args()
if not args.child:
    subprocess.Popen([sys.executable, __file__, str(args.root), '--child'])
output = args.root / ('child-heartbeat' if args.child else 'parent-heartbeat')
while True:
    output.write_text(str(time.monotonic_ns()))
    time.sleep(0.05)
