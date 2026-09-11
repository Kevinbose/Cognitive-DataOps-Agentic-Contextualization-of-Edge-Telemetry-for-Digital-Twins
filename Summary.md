# CAD to Interactive 3D Digital Twin — Detailed Work Summary

## 1. Overview

The first stage of the capstone project was to build a basic pipeline that converts a CAD model into an interactive 3D model that can be displayed and controlled in a web browser.

The overall workflow is:

```text
FreeCAD
   ↓
Create CAD assembly
   ↓
Assign unique component IDs
   ↓
Export as glTF + binary file
   ↓
Load using Three.js
   ↓
Display interactive 3D model
   ↓
Identify individual components
   ↓
Select components from a menu
   ↓
Change component state/color
```

The main objective of this stage is to prove that individual physical machine components can have corresponding digital objects in the 3D model. This will later allow sensor and fault information to be connected to specific components.

---

# 2. FreeCAD

## 2.1 Why FreeCAD was used

FreeCAD was used to create the initial CAD model of the machine assembly.

FreeCAD is suitable for this stage because:

- It is free and open source.
- It supports standard CAD formats.
- It can create individual solid components.
- It can export models to formats that can be used for web-based 3D visualization.

We used **FreeCAD 1.1.3**.

## 2.2 Workbench

The **Part workbench** was used to create the individual components.

This was important because we wanted the motor, shaft, and pump to remain separate objects rather than becoming one combined solid.

---

# 3. Creating the CAD Model

A simple three-component machine assembly was created to understand the complete CAD-to-web pipeline before working with a more complicated industrial model.

The assembly consists of:

| Component | Component ID | Description |
|---|---|---|
| Motor | `Motor_M001` | Main motor body |
| Shaft | `Shaft_S001` | Shaft connecting the components |
| Pump | `Pump_P001` | Pump body |

## 3.1 Motor

A cylindrical motor body was created.

It was assigned the name:

```text
Motor_M001
```

Here:

- `Motor` identifies the component type.
- `M001` acts as the unique component ID.

## 3.2 Shaft

A smaller cylindrical shaft was created separately.

It was assigned:

```text
Shaft_S001
```

The shaft was positioned so that it connects the motor and pump.

## 3.3 Pump

A second cylindrical body was created to represent the pump.

It was assigned:

```text
Pump_P001
```

## 3.4 Why unique names are important

The component names are more than labels.

They provide a way to connect the CAD component to its corresponding object in the digital twin.

For example:

```text
Physical Motor
      ↓
Motor_M001
      ↓
CAD object
      ↓
GLTF object
      ↓
Three.js object
```

Later, the same ID can be used to associate sensor data with the component:

```text
Motor_M001
   ↓
Temperature sensor
Vibration sensor
RPM sensor
   ↓
Fault detection
```

---

# 4. Exporting the CAD Model

After creating the assembly, the original CAD components were selected.

The model was exported from FreeCAD using:

```text
File → Export
```

The selected format was:

```text
glTF (*.gltf *.glb)
```

The resulting files were:

```text
Test.gltf
Test.bin
```

Both files were placed inside the project's `public` directory.

The project structure became approximately:

```text
digital-twin-demo/
│
├── public/
│   ├── Test.gltf
│   └── Test.bin
│
├── src/
│   ├── main.js
│   ├── style.css
│   └── ...
│
├── package.json
└── ...
```

---

# 5. Understanding glTF and `.bin`

The exported model consists of two related files.

## 5.1 Test.gltf

The `.gltf` file contains the description of the 3D model.

It includes information such as:

- Meshes
- Nodes
- Component names
- Positions
- Rotations
- Materials
- References to binary geometry data

The exported file contains separate meshes for:

```text
Motor_M001
Shaft_S001
Pump_P001
```

It also contains nodes with the same component names.

## 5.2 Test.bin

The `.bin` file contains the binary geometry data used by the glTF model.

The `Test.gltf` file references this file:

```json
"buffers": [
    {
        "byteLength": 15680,
        "uri": "Test.bin"
    }
]
```

Therefore, both files must be available to the web application.

---

# 6. Initial Export Issue and Solution

During the first export attempt, the generated glTF file contained no geometry.

It had:

```json
"meshes": [],
"nodes": []
```

This resulted in an empty model in Three.js.

The issue was related to exporting the generated Mesh objects rather than the original CAD Shape objects.

The solution was to:

1. Keep the original CAD components.
2. Select the original:
   - `Motor_M001`
   - `Shaft_S001`
   - `Pump_P001`
3. Export those objects directly as glTF.

The new export contained actual geometry.

For example, the final glTF contained:

```text
meshes:
    Motor_M001
    Shaft_S001
    Pump_P001
```

This confirmed that the CAD components were successfully preserved during export.

---

# 7. Creating the Three.js Application

A Vite-based JavaScript project was created for the web visualization.

The project was named:

```text
digital-twin-demo
```

Three.js was installed using npm.

The application uses:

- Three.js
- GLTFLoader
- OrbitControls
- JavaScript
- Vite

---

# 8. Loading the glTF Model in Three.js

The `GLTFLoader` provided by Three.js is used to load the exported model.

The basic process is:

```js
const loader = new GLTFLoader();

loader.load('/Test.gltf', (gltf) => {
    const model = gltf.scene;
    scene.add(model);
});
```

The model is then added to the Three.js scene.

The application also creates:

- A 3D scene
- A perspective camera
- A WebGL renderer
- Ambient lighting
- Directional lighting
- Orbit controls

---

# 9. Interactive 3D View

After loading the model, the camera is automatically positioned around the model.

`OrbitControls` allows the user to:

- Rotate the model.
- Zoom in and out.
- Move around the model.

Therefore, the CAD model is no longer just a static image. It becomes an interactive 3D representation that can be explored in a browser.

---

# 10. Identifying Individual Components

One of the most important parts of the implementation is that Three.js can access the individual components using their names.

For example:

```js
model.getObjectByName('Motor_M001');
```

Similarly:

```js
model.getObjectByName('Shaft_S001');
```

and:

```js
model.getObjectByName('Pump_P001');
```

This works because the component names were preserved from the CAD model during the glTF export.

This establishes the connection:

```text
FreeCAD component name
        ↓
glTF node name
        ↓
Three.js object name
```

---

# 11. Component Selection Menu

A small user interface menu was added to the web page.

The menu displays:

```text
COMPONENTS

Motor (M001)
Shaft (S001)
Pump (P001)
```

Each component has its own button.

The buttons are created dynamically using JavaScript.

Conceptually:

```text
Component list
      ↓
Create button
      ↓
Associate button with component ID
      ↓
Click button
      ↓
Find corresponding Three.js object
```

---

# 12. Changing Component Color

When a component button is clicked, the corresponding 3D component changes color.

The current behavior is:

```text
Default state
     ↓
Click component
     ↓
Component becomes RED
     ↓
Click same component again
     ↓
Component returns to DEFAULT color
```

For example:

```text
Motor (M001) → RED
```

The motor in the 3D scene changes to red.

Clicking it again:

```text
Motor (M001) → DEFAULT
```

returns it to its original color.

The same functionality works independently for the shaft and pump.

Multiple components can therefore be placed into the red state at the same time.

Example:

```text
Motor  → RED
Shaft  → DEFAULT
Pump   → RED
```

---

# 13. Handling the glTF Mesh Structure

The exported glTF model can contain multiple mesh primitives within a component.

Therefore, the implementation does not simply assume that a component has one material.

Instead, the code:

1. Finds the component object.
2. Traverses its children.
3. Finds all Three.js meshes.
4. Clones their materials.
5. Stores the meshes associated with that component.
6. Changes the color of all those meshes together.

Conceptually:

```text
Motor_M001
    │
    ├── Mesh
    ├── Mesh
    └── Mesh
         ↓
Change all mesh materials
         ↓
Entire motor becomes RED
```

This ensures that the complete component changes color rather than only one part of it.

---

# 14. Current Architecture

At the current stage, the system looks like:

```text
                 FREECAD
                    │
                    │
             CAD Assembly
                    │
        ┌───────────┼───────────┐
        ↓           ↓           ↓
   Motor_M001  Shaft_S001  Pump_P001
        │           │           │
        └───────────┼───────────┘
                    │
               GLTF Export
                    │
             Test.gltf + Test.bin
                    │
                    ↓
                THREE.JS
                    │
             GLTFLoader
                    │
                    ↓
             3D Digital Model
                    │
             Component IDs
                    │
          ┌─────────┼─────────┐
          ↓         ↓         ↓
       Motor      Shaft      Pump
          │         │         │
          └─────────┼─────────┘
                    ↓
             Component Menu
                    │
                    ↓
          Click Component Button
                    │
                    ↓
             Change Component
                    │
             DEFAULT ↔ RED
```

---

# 15. Why This Is Useful for the Digital Twin

The current red/default functionality is a simple demonstration, but it represents an important part of the final digital twin.

Currently:

```text
User click
    ↓
Component becomes red
```

Eventually, this can become:

```text
Sensor Data
    ↓
Data Processing
    ↓
Anomaly Detection
    ↓
Fault Diagnosis Agent
    ↓
Motor_M001 = ABNORMAL
    ↓
Three.js
    ↓
Motor automatically becomes RED
```

For example:

```json
{
    "component": "Motor_M001",
    "temperature": 82,
    "vibration": 8.3,
    "status": "abnormal"
}
```

The frontend could use the component ID to find:

```js
model.getObjectByName('Motor_M001')
```

and automatically change that component's appearance.

---

# 16. Future Extensions

The current implementation is only the **3D visualization foundation**.

The next stages can include:

### Stage 1 — Component information

When a component is selected, display:

```text
Motor M001

Status: Normal
Temperature: 65°C
Vibration: 2.1 mm/s
RPM: 1500
```

### Stage 2 — Simulated sensor data

Generate sensor values for each component.

Example:

```text
Motor:
Temperature = 82°C
Vibration = 8.3 mm/s
RPM = 1450
```

### Stage 3 — MQTT

Send real-time sensor data through MQTT:

```text
ESP32
  ↓
MQTT
  ↓
Backend
  ↓
Digital Twin
  ↓
Three.js
```

### Stage 4 — Anomaly detection

Detect abnormal sensor values using threshold-based rules or ML models.

Example:

```text
Vibration > threshold
        ↓
Anomaly detected
```

### Stage 5 — Fault diagnosis

An AI/agentic system can use sensor values and additional context to determine a possible fault.

Example:

```text
High vibration
+ High temperature
+ Reduced RPM
        ↓
Possible bearing/motor fault
```

### Stage 6 — Automatic visualization

The diagnosed component can automatically change state:

```text
NORMAL   → Grey/Default
WARNING  → Orange
FAULT    → Red
```

This will connect the 3D digital twin to the sensor and AI portions of the capstone.

---

# 17. Key Achievement So Far

The main achievement of this stage is that we have successfully demonstrated:

> **A CAD assembly can be exported while preserving individual component identities, loaded into a web-based Three.js environment, and controlled at the individual component level.**

The critical mapping is:

```text
Physical Component
       ↕
CAD Component ID
       ↕
GLTF Object
       ↕
Three.js Object
       ↕
Future Sensor / Fault Data
```

This mapping will serve as the foundation for connecting the 3D visualization to the rest of the industrial digital twin system.
