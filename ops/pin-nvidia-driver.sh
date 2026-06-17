#!/usr/bin/env bash
# ============================================================================
# pin-nvidia-driver.sh — freeze the NVIDIA driver so background apt upgrades
# can't silently skew the kernel module vs. userspace libraries again (the
# root cause of the "Dina runs on CPU" outage).
#
# After running this, NVIDIA driver updates become MANUAL + DELIBERATE:
#   1) sudo apt-mark unhold <the held packages>
#   2) sudo apt-get update && sudo apt-get upgrade
#   3) sudo reboot           # <-- always reboot after a driver change
#   4) re-run ops/verify-gpu.sh
#   5) sudo bash ops/pin-nvidia-driver.sh   # re-pin
#
# Safe to run repeatedly. Review before running in production.
# ============================================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run with sudo: sudo bash ops/pin-nvidia-driver.sh" >&2
  exit 1
fi

echo "Currently installed NVIDIA packages:"
dpkg -l | awk '/nvidia/ {print "  " $2 "  " $3}'

# Hold the active 580 driver stack + DKMS so it can't be auto-upgraded.
PKGS=$(dpkg -l \
  | awk '/^ii/ && $2 ~ /^(nvidia-driver-580|nvidia-dkms-580|nvidia-kernel-common-580|nvidia-kernel-source-580|nvidia-utils-580|nvidia-compute-utils-580|libnvidia-compute-580|libnvidia-gl-580|nvidia-firmware-580)/ {print $2}')

if [ -z "$PKGS" ]; then
  echo "No nvidia-*-580 packages found to hold. Aborting (check 'dpkg -l | grep nvidia')." >&2
  exit 1
fi

echo
echo "Holding the following packages (apt will not upgrade them):"
echo "$PKGS" | sed 's/^/  /'
# shellcheck disable=SC2086
apt-mark hold $PKGS

echo
echo "✅ Done. Current holds:"
apt-mark showhold | sed 's/^/  /'

cat <<'NOTE'

NEXT (recommended, manual):
  • Remove the stale second driver metapackage once 580 is confirmed working:
      sudo apt-get purge nvidia-driver-550 && sudo apt-get autoremove && sudo reboot
  • Consider excluding nvidia from unattended-upgrades, OR enabling automatic
    reboot at a safe hour in /etc/apt/apt.conf.d/50unattended-upgrades:
      Unattended-Upgrade::Automatic-Reboot "true";
      Unattended-Upgrade::Automatic-Reboot-Time "04:30";
NOTE