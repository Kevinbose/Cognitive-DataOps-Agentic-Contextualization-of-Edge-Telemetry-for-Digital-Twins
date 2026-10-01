# Demo binding cheat sheet

The demo needs six bindings, one per telemetry channel, on the car factory asset. This page lists them, shows how to make them in the viewer, and shows how to put them back in one command after a database reset.

## Which meshes to pick

`car_factory.glb` contains a six-axis welding robot (two of them), a spot weld gun and a stamping press, so the strongest demo binds to those. It has no lubrication unit, drive motor or bearing housing as separate parts, so for those you bind a mesh of the press and let the display label say what it stands for. Nothing searches the model for parts: you pick the mesh and the label carries the meaning.

Suggested meshes (node names as the component list shows them; click each to see what lights up, and swap if another part reads better):

| Channel | Mesh | Display label |
|---|---|---|
| Axis 4 servo torque | `105-six-axis-welding-robot/arm-swing` | Robot forearm (axis 4) |
| Tool centre point deviation | `105-six-axis-welding-robot/1` | Robot wrist and tool flange |
| Weld gun temperature | `095-spot-weld-gun-on-balancer/1` | Spot weld gun |
| Main motor current | `090-stamping-press/0` | Main drive motor |
| Lube oil pressure | `090-stamping-press/1` | Lubrication unit |
| Bearing vibration RMS | `090-stamping-press/ram/steel` | Main bearing housing |

Filter the component list by `welding`, `spot-weld` or `stamping` to find them. The binding table is the only link between a signal and a mesh, and nothing in the telemetry layer depends on mesh names, so another model needs only six new bindings.

## The six bindings

| Machine | Channel | Sensor ID | Sensor type | Display label for the mesh you pick |
|---|---|---|---|---|
| Welding robot 01 | Axis 4 servo torque | `ROBOT-WELD-01.AXIS_4_SERVO_TORQUE` | torque | Robot forearm (axis 4) |
| Welding robot 01 | Tool centre point deviation | `ROBOT-WELD-01.TOOL_CENTER_POINT_DEVIATION` | displacement | Robot wrist and tool flange |
| Welding robot 01 | Weld gun temperature | `ROBOT-WELD-01.WELD_GUN_TEMP` | temperature | Spot weld gun |
| Stamping press 01 | Main motor current | `PRESS-STAMP-01.MAIN_MOTOR_CURRENT` | current | Main drive motor |
| Stamping press 01 | Lube oil pressure | `PRESS-STAMP-01.LUBE_OIL_PRESSURE` | pressure | Lubrication unit |
| Stamping press 01 | Bearing vibration RMS | `PRESS-STAMP-01.BEARING_VIBRATION_RMS` | vibration | Main bearing housing |

One mesh takes one sensor, and one sensor drives one mesh. Six channels therefore need six different meshes.

Pick meshes you can see from the default camera position. The fault demo tints the mesh bound to lube oil pressure and the one bound to vibration, so choose meshes large enough to read from across a room, and keep those two apart from each other.

## Add the machines to the twin first

A gateway announces itself and is only **available**. Nothing from it shows on a twin, and none of its channels can be bound there, until you add it:

1. Open the car factory asset in the viewer. With no machine on the twin it opens on the **Machines** tab.
2. Under **Available to add**, choose **Add to this twin** for the stamping press and again for the welding robot. Each moves under **On this twin**.
3. Choose **Open Telemetry**. Their six channels are now live and bindable.

**Remove** takes a machine off the twin and retires the bindings of its channels, which stay as history. A machine belongs to one twin at a time.

## Make them in the viewer

1. In the viewer, switch the left panel to **Telemetry**.
2. On a channel row, choose **Bind**. The channel is preselected in the binding form.
3. Click a mesh in the viewport, or pick one from the **Components** list.
4. Check the sensor type, set the display label from the table above, and choose **Bind sensor**.
5. The mesh flashes green for about 1.6 seconds and a status message confirms the bind.
6. Repeat for the other five channels.

If a channel is already bound to another mesh, the form shows a conflict card with a **Reassign** button. Reassigning retires the old binding as history and binds the channel to the new mesh.

## Record the bindings

Once the six are made, record them so a reset can be undone:

```bash
npm run seed:demo --workspace server -- --capture
```

This reads the current bindings from the database and writes the mesh names into [`docs/demo-bindings.json`](demo-bindings.json). It never writes to the database. Commit the file, because glTF names are long and easy to mistype by hand.

You can also fill `meshName` in that file by hand. A `null` means the channel is not assigned yet.

## Replay after a reset

```bash
npm run seed:demo --workspace server -- --apply --bindings
```

Leave out `--apply` for a dry run that prints what would happen and changes nothing. The replay:

- renames the car factory asset to "Car Factory, Assembly Hall" if it still has the old name;
- binds each recorded channel through the same function the viewer uses, so the one-sensor-per-mesh rules hold;
- reports a channel that is already bound to a different mesh and leaves it where it is, rather than moving it;
- skips channels whose `meshName` is `null`;
- refuses to run against any database other than `cognitive_dataops` or a `cdo_test_*` one;
- never touches the machine shop asset.

Bindings are off by default in the seed, so you can still show binding live at the demo. Run the replay only when you want the twin ready before the audience arrives.

A running API refreshes its binding index within 30 seconds of a replay. Reload the viewer afterwards.
