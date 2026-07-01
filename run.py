"""Thin entry point: python run.py --input <dir> --output <dir>"""
import sys

from autolable.cli import main

if __name__ == "__main__":
    sys.exit(main())
