/*
 * Which machine this board plays.
 *
 *   1 = welding robot   (robot-weld-01)
 *   2 = stamping press  (press-stamp-01)
 *
 * Edit the number below in the Arduino IDE, or run
 *
 *     node scripts/fw.mjs select robot
 *     node scripts/fw.mjs select press
 *
 * which rewrites the same line. The #ifndef guard also lets a -DMACHINE_TYPE=2
 * compiler flag override it.
 *
 * Both boards run identical code. This one number is the only difference.
 */

#pragma once

#ifndef MACHINE_TYPE
#define MACHINE_TYPE 2
#endif
