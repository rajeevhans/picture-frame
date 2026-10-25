/*
 * display-rehandshake: force the main display's HDMI link to renegotiate by
 * switching to the same resolution at a different refresh rate and back.
 * A refresh change is a full modeset (link retrain + HDCP), the software
 * equivalent of replugging the cable. Uses only public CoreGraphics APIs.
 *
 * Build: clang -O2 -o display-rehandshake display-rehandshake.c -framework CoreGraphics -framework CoreFoundation
 * Usage: display-rehandshake            (do the switch)
 *        display-rehandshake --list     (print the current mode and its siblings)
 */
#include <CoreGraphics/CoreGraphics.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static void describe(const char *label, CGDisplayModeRef m) {
    printf("%s %zux%zu (%zux%zu px) @ %.2f Hz\n", label,
           CGDisplayModeGetWidth(m), CGDisplayModeGetHeight(m),
           CGDisplayModeGetPixelWidth(m), CGDisplayModeGetPixelHeight(m),
           CGDisplayModeGetRefreshRate(m));
}

int main(int argc, char **argv) {
    int listOnly = argc > 1 && strcmp(argv[1], "--list") == 0;
    CGDirectDisplayID display = CGMainDisplayID();
    CGDisplayModeRef current = CGDisplayCopyDisplayMode(display);
    if (!current) { fprintf(stderr, "no display mode (is a display connected?)\n"); return 2; }
    describe("current:", current);

    // Include HiDPI (scaled) variants so the current mode's siblings are found.
    const void *keys[] = { kCGDisplayShowDuplicateLowResolutionModes };
    const void *vals[] = { kCFBooleanTrue };
    CFDictionaryRef opts = CFDictionaryCreate(NULL, keys, vals, 1,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFArrayRef modes = CGDisplayCopyAllDisplayModes(display, opts);
    CFRelease(opts);

    // Same logical and pixel size, different (preferably lower) refresh rate.
    CGDisplayModeRef alt = NULL;
    double curHz = CGDisplayModeGetRefreshRate(current);
    for (CFIndex i = 0; i < CFArrayGetCount(modes); i++) {
        CGDisplayModeRef m = (CGDisplayModeRef)CFArrayGetValueAtIndex(modes, i);
        if (CGDisplayModeGetWidth(m) != CGDisplayModeGetWidth(current)
            || CGDisplayModeGetHeight(m) != CGDisplayModeGetHeight(current)
            || CGDisplayModeGetPixelWidth(m) != CGDisplayModeGetPixelWidth(current)
            || CGDisplayModeGetPixelHeight(m) != CGDisplayModeGetPixelHeight(current)
            || !CGDisplayModeIsUsableForDesktopGUI(m)) continue;
        double hz = CGDisplayModeGetRefreshRate(m);
        if (listOnly) describe("  sibling:", m);
        if (hz == curHz) continue;
        // Prefer 30 Hz: at 4K30 HDMI needs no scrambling, so coming back to
        // 60 Hz forces the TV's scrambling state to be re-sent too.
        if (!alt || (hz == 30.0 && CGDisplayModeGetRefreshRate(alt) != 30.0)) alt = m;
    }
    if (listOnly) return 0;
    if (!alt) { fprintf(stderr, "no alternate refresh rate for the current mode\n"); return 3; }

    describe("switching to:", alt);
    CGError err = CGDisplaySetDisplayMode(display, alt, NULL);
    if (err != kCGErrorSuccess) { fprintf(stderr, "switch failed: %d\n", err); return 4; }
    sleep(3);
    err = CGDisplaySetDisplayMode(display, current, NULL);
    if (err != kCGErrorSuccess) {
        sleep(2);
        err = CGDisplaySetDisplayMode(display, current, NULL);  // one retry
    }
    if (err != kCGErrorSuccess) { fprintf(stderr, "restore failed: %d\n", err); return 5; }
    CGDisplayModeRef now = CGDisplayCopyDisplayMode(display);
    describe("restored:", now);
    return 0;
}
