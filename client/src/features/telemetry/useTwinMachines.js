/**
 * @file Which machines are on this twin, and which are only available.
 *
 * A gateway announces itself and is listed by the server, but belongs to no twin
 * until someone adds it. Everything that shows live data or offers channels for
 * binding works from the machines ON the twin; the Machines tab is where the
 * rest are found and added.
 *
 * @module features/telemetry/useTwinMachines
 */

import { useMemo } from 'react';

import { useAppSelector } from '../../app/hooks.js';
import { selectDeviceList } from './telemetrySlice.js';

/**
 * @param {string|undefined} assetId - The twin being viewed.
 * @returns {{
 *   attached: any[],
 *   available: any[],
 *   elsewhere: any[],
 * }} Machines on this twin; machines on no twin; machines on a different twin.
 */
export function useTwinMachines(assetId) {
  const devices = useAppSelector(selectDeviceList);

  return useMemo(
    () => ({
      // Everything added to this twin, whatever its state: an offline machine
      // here is news ("the press dropped off"), so it stays visible.
      attached: devices.filter((device) => device.assetId === assetId),
      // Only machines that are online now and on no twin can be added. An
      // offline gateway nobody has claimed is noise in this list.
      available: devices.filter((device) => !device.assetId && device.state === 'online'),
      // Live machines claimed by another twin, so the operator knows where they went.
      elsewhere: devices.filter(
        (device) => device.assetId && device.assetId !== assetId && device.state === 'online',
      ),
    }),
    [devices, assetId],
  );
}

export default useTwinMachines;
