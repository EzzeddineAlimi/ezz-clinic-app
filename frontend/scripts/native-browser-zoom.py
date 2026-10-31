#!/usr/bin/env python3
"""Send one real desktop Ctrl+Plus keystroke to focused Chromium over X11.

Playwright's synthetic page.keyboard events do not change browser zoom.
Requires headed Chromium on Xvfb; stdlib ctypes and X11/XTest libraries only.
"""
import ctypes

x11 = ctypes.CDLL("libX11.so.6")
xtest = ctypes.CDLL("libXtst.so.6")
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
x11.XStringToKeysym.restype = ctypes.c_ulong
x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XKeysymToKeycode.restype = ctypes.c_uint
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
xtest.XTestFakeKeyEvent.argtypes = [
    ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong
]
xtest.XTestFakeKeyEvent.restype = ctypes.c_int

display = x11.XOpenDisplay(None)
if not display:
    raise RuntimeError("Headed Chromium must run under Xvfb (DISPLAY absent)")

try:
    ctrl = x11.XKeysymToKeycode(display, x11.XStringToKeysym(b"Control_L"))
    plus = x11.XKeysymToKeycode(display, x11.XStringToKeysym(b"plus"))
    if not ctrl or not plus:
        raise RuntimeError("X11 keyboard mapping missing Ctrl or Plus")
    for key, pressed in ((ctrl, 1), (plus, 1), (plus, 0), (ctrl, 0)):
        if xtest.XTestFakeKeyEvent(display, key, pressed, 0) != 1:
            raise RuntimeError("Native X11 key dispatch failed")
    x11.XFlush(display)
finally:
    x11.XCloseDisplay(display)
