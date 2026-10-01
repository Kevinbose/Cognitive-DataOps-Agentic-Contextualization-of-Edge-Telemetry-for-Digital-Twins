# Thesis narrative

About 300 words, written for the review panel. It describes the architecture the way a plant engineer would, so that a panelist who knows the field cannot catch an overclaim.

Status when this was written: the platform up to the live twin is built and tested, and the agentic layer is specified in [`phase5-agent-blueprint.md`](phase5-agent-blueprint.md) but not yet built. The last paragraph says so.

---

Modern automotive plants rarely need bolt-on sensors to watch their machines. A welding robot or a stamping press already contains a controller that continuously computes its own internal state: servo torque, path deviation, motor current, lubrication pressure. That data leaves the machine through industrial interfaces such as OPC UA or MTConnect, and plants normalise it at the edge through a gateway onto a publish and subscribe backbone. The backbone is an MQTT broker organised as a Unified Namespace, where every machine publishes to a predictable topic hierarchy and every consumer subscribes to what it needs, with no point to point wiring.

Our prototype reproduces that architecture. Two ESP32 microcontrollers act as Edge Telemetry Gateways, each simulating one machine's controller: a six axis welding robot and a stamping press. On connection, each gateway publishes a retained birth message that declares its channels, units and alarm limits. It then streams telemetry over TLS secured MQTT, and a Last Will message tells the platform within one keep-alive window, about fifteen seconds, if a gateway drops off the network.

A Node.js ingestion service subscribes to the broker, validates every message, stores it in a MongoDB time series collection and pushes it over WebSockets to a React Three Fiber digital twin. Operators bind any telemetry channel to any component of the 3D model. That binding table is the semantic bridge between a raw signal and a physical part.

The contribution we are building towards is what happens next. Dashboards flood operators with alarms yet cannot explain them. The agentic layer we have designed correlates channels, retrieves the maintenance manual, tests competing hypotheses such as a worn drive bearing against a clogged lubrication filter, and then uses the operator's own bindings to highlight the responsible component in 3D, with cited evidence. The operator receives a located, explained root cause instead of another flashing alarm.
