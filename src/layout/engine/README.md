# Canvas layout engine

The engine modules contain framework-independent layout contracts and pure
geometry, alignment, and layer-order functions. They do not import React,
Tauri, application components, or a storage implementation.

`CanvasDocument<TPayload>` is the generic runtime contract. Its payload is
owned by the host application; `placement` contains independent desktop,
tablet, and mobile rectangles, `spacingPx` stores decimal spacing, and
`zIndex` orders items on one canvas.
Coordinates are finite CSS-pixel values and may be negative. Width and height
must be positive. Overlap is valid and is never treated as a collision error.

`positioning.ts`, `resizing.ts`, `interaction.ts`, `magnetism.ts`, `guides.ts`,
and `layers.ts` separate their pure operations. `updateCanvasGesture` accepts a
generic payload, pointer coordinates, alignment targets, and resize edges; a
host UI owns pointer capture and commits the returned geometry. Alignment guides are measurements.
`alignCanvasRect` only changes coordinates when its caller explicitly enables
snapping; disabling snapping preserves the input rectangle. Distances report
negative gaps when objects overlap. Layer ordering does not change item
geometry or payload. Responsive updates replace only the requested profile.

The Bonobos layout schema and Local Storage repository remain application
adapters. Schema V3 marks migrated pages as `flow`, preserving their existing
tree and rendering. The generic canvas contract is versioned independently so
another host can reuse the engine without adopting Bonobos component types.
The editor uses a separate React adapter for pointer capture, selection,
controls, and persistence; these remain outside the framework-independent
engine layer.

In schema V3, `layoutMode` selects the renderer; it does not discard free-layout
geometry. A flow renderer ignores `placement` and `zIndex`, while switching
back to free placement preserves existing values and initializes only missing
geometry. The component tree is shared between modes.
