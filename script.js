// Legacy globals only (no ESM)
(function () {
    const canvas = document.getElementById('viewport');
    const fileInput = document.getElementById('fileInput');
    const inflateRange = document.getElementById('inflateRange');
    const resetBtn = document.getElementById('resetBtn');
    const flatBtn = document.getElementById('flatBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const centerBtn = document.getElementById('centerBtn');
    const statusEl = document.getElementById('status');
    const flatStateEl = document.getElementById('flatState');

    // Scene setup
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight - 120);
    // Dark mode background
    renderer.setClearColor(0x2c2c2c, 1);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x2c2c2c);
    // Use Z-up like common DCC apps
    scene.up.set(0, 0, 1);

    const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 1000);
    camera.up.set(0, 0, 1);
    camera.position.set(0, -2.5, 0.25);

    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    // Separate transform gizmos
    const gizmoModel = new THREE.TransformControls(camera, renderer.domElement);
    gizmoModel.setSpace('world');
    gizmoModel.visible = false;
    scene.add(gizmoModel);

    controls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.PAN,
        RIGHT: THREE.MOUSE.ROTATE
    }

    const gizmoCenter = new THREE.TransformControls(camera, renderer.domElement);
    gizmoCenter.setSpace('world');
    gizmoCenter.setMode('translate');
    gizmoCenter.visible = false;
    scene.add(gizmoCenter);

    // Lights
    const hemi = new THREE.HemisphereLight(0xffffff, 0x202030, 0.8);
    hemi.position.set(0, 0, 1);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(3, 4, 5);
    scene.add(dir);
    const amb = new THREE.AmbientLight(0xffffff, 0.2);
    scene.add(amb);

    // Helper grid (XY plane) will be created after model load to match scale
    let grid = null;

    // Mesh state
    let mesh = null;
    let meshWire = null;
    let baseGeometry = null;
    let basePositions = null; // Float32Array snapshot of original positions
    let bloatCenter = null; // THREE.Vector3
    let centerMarker = null; // visual marker for bloat center
    let centerDirty = false; // trigger re-apply while center is moved
    let baseRadius = 1;
    let bboxHelper = null;
    let basePlaneZWorld = 0; // world-space Z for XY helper plane
    let basePlaneZLocal = 0; // local/object-space Z for clamping geometry
    let flatBaseActive = false;

    // UI state
    let inflateAmount = 0.0; // -1..1

    function setStatus(text) {
        // Status removed from UI; keep console for debugging
        if (statusEl) statusEl.textContent = '';
        if (text) console.log('[inflate3D]', text);
    }

    function debugGeometry(geom, label = 'geometry') {
        try {
            if (!geom) {
                console.warn(`[inflate3D] ${label}: null/undefined`);
                return;
            }
            const pos = geom.getAttribute && geom.getAttribute('position');
            const idx = geom.getIndex && geom.getIndex();
            geom.computeBoundingBox?.();
            geom.computeBoundingSphere?.();
            const bb = geom.boundingBox;
            const bs = geom.boundingSphere;
            console.log(`[inflate3D] ${label}:`, {
                positionCount: pos ? pos.count : 0,
                indexCount: idx ? idx.count : 0,
                hasNormals: !!geom.getAttribute?.('normal'),
                bboxMin: bb ? bb.min : null,
                bboxMax: bb ? bb.max : null,
                bSphereCenter: bs ? bs.center : null,
                bSphereRadius: bs ? bs.radius : null,
            });
        } catch (e) {
            console.error(`[inflate3D] debugGeometry error:`, e);
        }
    }

    function fitCameraToObject(object3D) {
        if (!object3D) return;
        // Work on a fresh Box3 so helper stays in sync after transform
        const box = new THREE.Box3().setFromObject(object3D);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const minZWorld = box.min.z; // before centering
        // Translate both mesh and wireframe together by parenting
        object3D.position.sub(center);
        // Always point camera/orbit at model center (origin after centering)
        controls.target.set(0, 0, 0);
        camera.lookAt(0, 0, 0);
        controls.update();
        let maxDim = Math.max(size.x, size.y, size.z);
        if (!Number.isFinite(maxDim) || maxDim <= 0) {
            maxDim = 1; // fallback to sane defaults
        }
        const fov = camera.fov * (Math.PI / 180);
        const baseDistance = Math.abs(maxDim / (2 * Math.tan(fov / 2)));
        // Start a little farther and at a gentle angle
        const distanceScale = 1.6; // slightly zoomed out compared to straight-on
        const yawDeg = 30;         // rotate around Z so model is not straight-on
        const pitchDeg = 20;       // elevate a bit
        const radius = baseDistance * distanceScale;
        const yaw = THREE.MathUtils.degToRad(yawDeg);
        const pitch = THREE.MathUtils.degToRad(pitchDeg);
        const horiz = Math.cos(pitch) * radius;
        const z = Math.sin(pitch) * radius;
        const x = Math.sin(yaw) * horiz;
        const y = -Math.cos(yaw) * horiz; // negative Y is "front"
        camera.position.set(x, y, z);
        camera.near = Math.max(0.001, radius / 1000);
        camera.far = radius * 100;
        camera.updateProjectionMatrix();
        // Normalize control distances to model size so navigation remains usable
        controls.minDistance = Math.max(0.001, maxDim * 0.02);
        controls.maxDistance = Math.max(10, maxDim * 50);
        controls.update();
        updateBBoxHelper();
        // Create/update XY grid sized to model, positioned at the model's lowest Z
        if (grid) {
            scene.remove(grid);
            grid.geometry?.dispose?.();
            grid.material?.dispose?.();
            grid = null;
        }
        const divisions = 20;
        const gridSize = Math.max(1, Math.ceil(maxDim * 1.5));
        // Slightly lighter lines on dark bg
        grid = new THREE.GridHelper(gridSize, divisions, 0x6b7280, 0x9ca3af);
        grid.rotation.x = Math.PI / 2; // XY plane (Z-up)
        grid.material.opacity = 0.35;
        grid.material.transparent = true;
        // After translating mesh by -center, the bottom Z becomes (minZWorld - center.z)
        const minZAfterCenter = minZWorld - center.z; // world
        grid.position.z = minZAfterCenter;
        basePlaneZWorld = minZAfterCenter;
        basePlaneZLocal = minZWorld; // local geometry did not change when we moved the object
        scene.add(grid);
        // Attach model gizmo to object origin and keep hidden until clicked
        gizmoModel.attach(object3D);
        gizmoModel.position.set(0, 0, 0);
        gizmoModel.visible = false;
    }

    function clearMesh() {
        if (mesh) {
            // Detach/hide gizmos from previous model
            if (typeof gizmoModel !== 'undefined') { try { gizmoModel.detach(); } catch (e) { } gizmoModel.visible = false; }
            if (typeof gizmoCenter !== 'undefined') { try { gizmoCenter.detach(); } catch (e) { } gizmoCenter.visible = false; }
            if (meshWire) {
                // dispose child wireframe first
                mesh.remove(meshWire);
                meshWire.geometry?.dispose?.();
                meshWire.material?.dispose?.();
                meshWire = null;
            }
            scene.remove(mesh);
            mesh.geometry?.dispose?.();
            if (Array.isArray(mesh.material)) {
                mesh.material.forEach((m) => m.dispose?.());
            } else {
                mesh.material?.dispose?.();
            }
            mesh = null;
        }
        if (bboxHelper) {
            scene.remove(bboxHelper);
            bboxHelper.geometry?.dispose?.();
            bboxHelper.material?.dispose?.();
            bboxHelper = null;
        }
        if (grid) {
            scene.remove(grid);
            grid.geometry?.dispose?.();
            grid.material?.dispose?.();
            grid = null;
        }
        baseGeometry = null;
        basePositions = null;
        bloatCenter = null;
        baseRadius = 1;
    }

    function updateBBoxHelper() {
        // No-op: remove any existing helper and do not recreate
        if (bboxHelper) {
            scene.remove(bboxHelper);
            bboxHelper.geometry?.dispose?.();
            bboxHelper.material?.dispose?.();
            bboxHelper = null;
        }
    }

    function createMaterials() {
        // Original shaded material
        const mat = new THREE.MeshStandardMaterial({
            color: 0xf7a8d9,
            metalness: 0.1,
            roughness: 0.35,
            flatShading: false,
        });
        return mat;
    }

    // No wireframe overlay per request

    // Custom Bloat implementation (from Bloat.ts logic)
    const BLOOM_DECAY_A = 0.01; // Bloat.ts default 'a'
    let lastAppliedAmount = 0;

    function applyBloatCPU(amount) {
        if (!mesh || !mesh.geometry || !basePositions || !bloatCenter) return;
        const pos = mesh.geometry.getAttribute('position');
        const arr = pos.array;
        const cx = bloatCenter.x, cy = bloatCenter.y, cz = bloatCenter.z;
        const r = amount * baseRadius;

        const doDeform = Math.abs(amount) >= 1e-6;
        if (!doDeform) {
            // No deformation, restore base vertices but still allow clamping below
            arr.set(basePositions);
        } else {
            for (let i = 0; i < arr.length; i += 3) {
                const x0 = basePositions[i];
                const y0 = basePositions[i + 1];
                const z0 = basePositions[i + 2];
                let ux = x0 - cx;
                let uy = y0 - cy;
                let uz = z0 - cz;
                const len = Math.hypot(ux, uy, uz);
                if (len > 1e-12) {
                    const newLen = len + r * Math.exp(-len * BLOOM_DECAY_A);
                    const s = newLen / len;
                    ux *= s; uy *= s; uz *= s;
                    arr[i] = cx + ux;
                    arr[i + 1] = cy + uy;
                    arr[i + 2] = cz + uz;
                } else {
                    arr[i] = x0; arr[i + 1] = y0; arr[i + 2] = z0;
                }
            }
        }
        // If Flat Base is active, clamp against the world XY plane regardless of model rotation
        if (flatBaseActive) {
            mesh.updateMatrixWorld();
            const worldMat = mesh.matrixWorld;
            const invWorld = new THREE.Matrix4().copy(worldMat).invert();
            const v = new THREE.Vector3();
            for (let i = 0; i < pos.count; i++) {
                v.set(arr[i * 3 + 0], arr[i * 3 + 1], arr[i * 3 + 2]);
                v.applyMatrix4(worldMat);
                if (v.z < basePlaneZWorld) {
                    v.z = basePlaneZWorld;
                    v.applyMatrix4(invWorld);
                    arr[i * 3 + 0] = v.x;
                    arr[i * 3 + 1] = v.y;
                    arr[i * 3 + 2] = v.z;
                }
            }
        }
        pos.needsUpdate = true;
        mesh.geometry.computeVertexNormals();
        lastAppliedAmount = amount;
    }

    function animate() {
        requestAnimationFrame(animate);
        controls.update();
        // Disable orbit while dragging gizmo
        controls.enabled = !(gizmoModel.dragging || gizmoCenter.dragging);
        // Apply our CPU bloat when slider changes
        if (inflateAmount !== lastAppliedAmount || flatBaseActive || (centerMarker && gizmoCenter.dragging) || centerDirty) {
            applyBloatCPU(inflateAmount);
            centerDirty = false;
        }
        renderer.render(scene, camera);
    }

    function onResize() {
        const rect = canvas.getBoundingClientRect();
        const width = rect.width || window.innerWidth;
        const height = rect.height || window.innerHeight - 120;
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
    }
    window.addEventListener('resize', onResize);

    const stlLoader = new THREE.STLLoader();
    fileInput.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        console.log('[inflate3D] Upload selected:', { name: file.name, size: file.size, type: file.type });
        setStatus('Loading STL...');
        try {
            console.time('[inflate3D] read file arrayBuffer');
            const arrayBuffer = await file.arrayBuffer();
            console.timeEnd('[inflate3D] read file arrayBuffer');
            console.log('[inflate3D] arrayBuffer bytes:', arrayBuffer.byteLength);
            console.time('[inflate3D] STL parse');
            const geometry = stlLoader.parse(arrayBuffer);
            console.timeEnd('[inflate3D] STL parse');
            geometry.computeVertexNormals();
            // Reset scene and center geometry at its bounding-box center so the pivot matches the visual center
            clearMesh();
            geometry.computeBoundingBox();
            const geoCenter = geometry.boundingBox.getCenter(new THREE.Vector3());
            geometry.translate(-geoCenter.x, -geoCenter.y, -geoCenter.z);
            baseGeometry = geometry.clone();
            const material = createMaterials();
            mesh = new THREE.Mesh(geometry, material);
            scene.add(mesh);
            // No wireframe overlay
            // Init bloat references
            const pos = mesh.geometry.getAttribute('position');
            basePositions = new Float32Array(pos.array);
            mesh.geometry.computeBoundingSphere();
            bloatCenter = mesh.geometry.boundingSphere ? mesh.geometry.boundingSphere.center.clone() : new THREE.Vector3();
            baseRadius = mesh.geometry.boundingSphere ? mesh.geometry.boundingSphere.radius : 1;
            debugGeometry(mesh.geometry, 'uploaded geometry');
            fitCameraToObject(mesh);
            updateBBoxHelper(mesh, 0x00ffff);
            mesh.userData.hovered = false;
            // Setup/position bloat center marker
            if (!centerMarker) {
                const s = Math.max(0.01, baseRadius * 0.03);
                const geo = new THREE.SphereGeometry(s, 16, 16);
                const mat = new THREE.MeshBasicMaterial({ color: 0x00ffd5, transparent: true, opacity: 0.8 });
                centerMarker = new THREE.Mesh(geo, mat);
            }
            centerMarker.position.copy(bloatCenter);
            mesh.add(centerMarker);
            centerMarker.visible = false;
            // Reset inflate slider to 0 on upload
            inflateAmount = 0;
            if (inflateRange) inflateRange.value = '0';
            const lblUp = document.getElementById('inflateVal');
            if (lblUp) lblUp.value = '0.00';
            setStatus('Use the slider to inflate/deflate.');
        } catch (err) {
            console.error('[inflate3D] Upload failure:', err);
            setStatus('Failed to load STL');
        }
    });

    inflateRange.addEventListener('input', (e) => {
        inflateAmount = parseFloat(e.target.value);
        const lbl = document.getElementById('inflateVal');
        if (lbl) lbl.value = inflateAmount.toFixed(2);
    });

    // Allow users to type a value directly
    const inflateValInput = document.getElementById('inflateVal');
    // Initialize numeric field to 0 and wire two-way binding
    if (inflateValInput) {
        inflateValInput.value = '0.00';
        inflateValInput.addEventListener('input', (e) => {
            const raw = parseFloat(e.target.value);
            if (!Number.isFinite(raw)) return;
            const clamped = Math.max(-1, Math.min(1, raw));
            inflateAmount = clamped;
            inflateRange.value = clamped.toString();
        });
        inflateValInput.addEventListener('change', () => {
            // Normalize formatting
            inflateValInput.value = (+inflateRange.value).toFixed(2);
        });
    }

    resetBtn.addEventListener('click', () => {
        inflateAmount = 0;
        inflateRange.value = '0';
        const lblReset = document.getElementById('inflateVal');
        if (lblReset) lblReset.value = '0.00';
        // Ensure Flat Base is fully reset to OFF state
        flatBaseActive = false;
        if (flatBtn) {
            flatBtn.classList.remove('bg-pink-600', 'hover:bg-pink-500');
            flatBtn.classList.add('bg-gray-800');
            flatBtn.textContent = 'Flat Base: OFF';
        }
        if (flatStateEl) flatStateEl.textContent = 'Flat Base: OFF';
        if (mesh && basePositions) {
            const pos = mesh.geometry.getAttribute('position');
            pos.array.set(basePositions);
            pos.needsUpdate = true;
            mesh.geometry.computeVertexNormals();
            lastAppliedAmount = 0;
            // Reset model transform (position/rotation/scale)
            mesh.position.set(0, 0, 0);
            mesh.rotation.set(0, 0, 0);
            mesh.scale.set(1, 1, 1);
            mesh.updateMatrixWorld(true);
            // Reset gizmos visibility/state
            if (typeof gizmoModel !== 'undefined') gizmoModel.visible = false;
            if (typeof gizmoCenter !== 'undefined') gizmoCenter.visible = false;
            // Refit camera to object and rebuild grid plane
            fitCameraToObject(mesh);
        }
        setStatus('Reset to original.');
    });

    // Download current mesh as STL
    downloadBtn?.addEventListener('click', () => {
        if (!mesh) return;
        try {
            const exporter = new THREE.STLExporter();
            // Export ONLY the model geometry, excluding helper marker/gizmos
            const exportGeometry = mesh.geometry.clone();
            const exportMaterial = new THREE.MeshStandardMaterial();
            const exportMesh = new THREE.Mesh(exportGeometry, exportMaterial);
            exportMesh.applyMatrix4(mesh.matrixWorld);
            const stlString = exporter.parse(exportMesh, { binary: false });
            const blob = new Blob([stlString], { type: 'model/stl' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'inflate3D_model.stl';
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            setStatus('Downloaded .STL');
        } catch (e) {
            console.error('[inflate3D] STL export failed:', e);
            setStatus('STL export failed');
        }
    });

    // Flat Base toggle: when ON, clamp deformations so vertices do not pass below the XY helper plane
    flatBtn?.addEventListener('click', () => {
        flatBaseActive = !flatBaseActive;
        if (flatBaseActive) {
            flatBtn.classList.remove('bg-gray-800');
            flatBtn.classList.add('bg-pink-600', 'hover:bg-pink-500');
            // Reflect current state on the button label
            if (flatBtn) flatBtn.textContent = 'Flat Base: ON';
            setStatus('Flat Base: ON');
            if (flatStateEl) flatStateEl.textContent = 'Flat Base: ON';
            // Snap any existing below-plane vertices up to the plane immediately
            if (mesh && mesh.geometry) {
                // Clamp in world space to the visible XY plane
                const pos = mesh.geometry.getAttribute('position');
                const arr = pos.array;
                mesh.updateMatrixWorld();
                const worldMat = mesh.matrixWorld;
                const invWorld = new THREE.Matrix4().copy(worldMat).invert();
                const v = new THREE.Vector3();
                for (let i = 0; i < pos.count; i++) {
                    v.set(arr[i * 3 + 0], arr[i * 3 + 1], arr[i * 3 + 2]).applyMatrix4(worldMat);
                    if (v.z < basePlaneZWorld) v.z = basePlaneZWorld;
                    v.applyMatrix4(invWorld);
                    arr[i * 3 + 0] = v.x;
                    arr[i * 3 + 1] = v.y;
                    arr[i * 3 + 2] = v.z;
                }
                pos.needsUpdate = true;
                mesh.geometry.computeVertexNormals();
            }
        } else {
            flatBtn.classList.remove('bg-pink-600', 'hover:bg-pink-500');
            flatBtn.classList.add('bg-gray-800');
            if (flatBtn) flatBtn.textContent = 'Flat Base: OFF';
            setStatus('Flat Base: OFF');
            if (flatStateEl) flatStateEl.textContent = 'Flat Base: OFF';
            // Re-render current deformation without the clamp by rebuilding from base
            if (mesh && mesh.geometry && basePositions) {
                const pos = mesh.geometry.getAttribute('position');
                pos.array.set(basePositions);
                pos.needsUpdate = true;
                mesh.geometry.computeVertexNormals();
                // Reapply current inflate amount without clamp
                applyBloatCPU(inflateAmount);
            }
        }
    });

    onResize();
    // Ensure slider UI mirrors initial value on first paint
    if (inflateRange) inflateRange.value = '0';
    const initialLbl = document.getElementById('inflateVal');
    if (initialLbl) initialLbl.value = '0.00';
    animate();
    setStatus('Loading default model...');

    // Hover + click to show transform gizmo
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    function updatePointer(event) {
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    }

    renderer.domElement.addEventListener('mousemove', (e) => {
        if (!mesh) return;
        updatePointer(e);
        raycaster.setFromCamera(pointer, camera);
        const intersects = raycaster.intersectObject(mesh, true);
        const hovering = intersects.length > 0;
        if (hovering !== mesh.userData.hovered) {
            mesh.userData.hovered = hovering;
            const mat = mesh.material;
            const baseColor = 0xf7a8d9;
            const hoverColor = 0xe08fc1; // slightly darker
            if (Array.isArray(mat)) {
                mat[0].color.setHex(hovering ? hoverColor : baseColor);
            } else {
                mat.color.setHex(hovering ? hoverColor : baseColor);
            }
        }
    });

    renderer.domElement.addEventListener('mousedown', (e) => {
        if (!mesh) return;
        updatePointer(e);
        raycaster.setFromCamera(pointer, camera);
        const intersectsModel = raycaster.intersectObject(mesh, true);
        const hitModel = intersectsModel.length > 0;
        let hitCenter = false;
        // Give priority to gizmo arrows/handles if hovered
        if (gizmoCenter && gizmoCenter.visible && gizmoCenter.axis !== null) {
            hitCenter = true;
        } else if (centerMarker && centerMarker.visible) {
            // Fallback: click directly on the marker sphere
            const intersectsCenter = raycaster.intersectObject(centerMarker, true);
            hitCenter = intersectsCenter.length > 0;
        }

        if (hitCenter) {
            // Clicked on center marker: show center gizmo (translate only), hide model gizmo
            gizmoCenter.attach(centerMarker);
            gizmoCenter.visible = true;
            gizmoCenter.setMode('translate');
            // Fully disable model gizmo to avoid accidental model moves
            gizmoModel.visible = false;
            gizmoModel.detach();
            gizmoModel.enabled = false;
            centerBtn.textContent = 'Inflate Sphere Position: ON';
        } else if (hitModel) {
            // Attach/show model gizmo; fully exit center edit state
            gizmoModel.attach(mesh);
            gizmoModel.position.set(0, 0, 0); // gizmo uses attached object's origin
            gizmoModel.setSpace('local'); // rotate around model bbox center (local origin)
            gizmoModel.visible = true;
            gizmoModel.setMode(currentModelMode);
            gizmoModel.enabled = true;
            if (gizmoCenter) {
                gizmoCenter.detach();
                gizmoCenter.visible = false;
            }
            if (centerMarker) {
                centerMarker.visible = false;
                centerBtn.textContent = 'Inflate Sphere Position: OFF';
            }
        } else {
            // Clicked empty space: hide both gizmos (center marker can remain visible)
            if (gizmoModel) {
                gizmoModel.visible = false;
                gizmoModel.detach();
                gizmoModel.enabled = false;
            }
            if (gizmoCenter) {
                gizmoCenter.detach();
                gizmoCenter.visible = false;
            }
        }
    });

    // Transform mode buttons
    const modeMoveBtn = document.getElementById('modeMove');
    const modeRotateBtn = document.getElementById('modeRotate');
    let currentModelMode = 'translate';
    modeMoveBtn?.addEventListener('click', () => {
        currentModelMode = 'translate';
        if (gizmoModel) gizmoModel.setMode('translate');
        modeMoveBtn.classList.add('bg-gray-700');
        modeRotateBtn.classList.remove('bg-gray-700');
    });
    modeRotateBtn?.addEventListener('click', () => {
        currentModelMode = 'rotate';
        // Only change model gizmo; center gizmo remains translate-only
        if (gizmoModel) gizmoModel.setMode('rotate');
        modeRotateBtn.classList.add('bg-gray-700');
        modeMoveBtn.classList.remove('bg-gray-700');
    });

    // Toggle center marker manipulation
    centerBtn?.addEventListener('click', () => {
        if (!mesh || !centerMarker) return;
        centerMarker.visible = !centerMarker.visible;
        if (centerMarker.visible) {
            gizmoCenter.attach(centerMarker);
            gizmoCenter.visible = true;
            gizmoCenter.setMode('translate');
            if (gizmoModel) {
                gizmoModel.visible = false;
                gizmoModel.detach();
                gizmoModel.enabled = false;
            }
            centerBtn.textContent = 'Inflate Sphere Position: ON';
        } else {
            gizmoCenter.detach();
            gizmoCenter.visible = false;
            // Re-enable model gizmo only when user clicks the model again
            centerBtn.textContent = 'Inflate Sphere Position: OFF';
        }
    });

    // When marker is moved, update bloat center (mesh-local) and re-apply inflation live
    gizmoCenter.addEventListener('change', () => {
        if (centerMarker && centerMarker.visible) {
            bloatCenter.copy(centerMarker.position);
            centerDirty = true;
        }
    });

    // (Removed per-frame gizmo repositioning to avoid offset issues)

    // Load default model from ./model directory
    (async () => {
        try {
            const res = await fetch('./model/skull_mesh.stl');
            if (!res.ok) throw new Error('Failed to fetch default STL');
            console.time('[inflate3D] default fetch arrayBuffer');
            const arrayBuffer = await res.arrayBuffer();
            console.timeEnd('[inflate3D] default fetch arrayBuffer');
            console.time('[inflate3D] default STL parse');
            const geometry = stlLoader.parse(arrayBuffer);
            console.timeEnd('[inflate3D] default STL parse');
            geometry.computeVertexNormals();
            // keep original placement; only fit camera
            clearMesh();
            geometry.computeBoundingBox();
            const geoCenterDef = geometry.boundingBox.getCenter(new THREE.Vector3());
            geometry.translate(-geoCenterDef.x, -geoCenterDef.y, -geoCenterDef.z);
            baseGeometry = geometry.clone();
            const material = createMaterials();
            mesh = new THREE.Mesh(geometry, material);
            scene.add(mesh);
            // No wireframe overlay
            // Init bloat references
            const pos = mesh.geometry.getAttribute('position');
            basePositions = new Float32Array(pos.array);
            mesh.geometry.computeBoundingSphere();
            bloatCenter = mesh.geometry.boundingSphere ? mesh.geometry.boundingSphere.center.clone() : new THREE.Vector3();
            baseRadius = mesh.geometry.boundingSphere ? mesh.geometry.boundingSphere.radius : 1;
            debugGeometry(mesh.geometry, 'default geometry');
            fitCameraToObject(mesh);
            updateBBoxHelper(mesh, 0xff00ff);
            setStatus('Use the slider to inflate/deflate.');
            // Setup/position bloat center marker for default model
            if (!centerMarker) {
                const s = Math.max(0.01, baseRadius * 0.03);
                const geo = new THREE.SphereGeometry(s, 16, 16);
                const mat = new THREE.MeshBasicMaterial({ color: 0x00ffd5, transparent: true, opacity: 0.8 });
                centerMarker = new THREE.Mesh(geo, mat);
            }
            centerMarker.position.copy(bloatCenter);
            mesh.add(centerMarker);
            centerMarker.visible = false;
            // Ensure slider starts at 0 for default model
            inflateAmount = 0;
            if (inflateRange) inflateRange.value = '0';
            const lblDef = document.getElementById('inflateVal');
            if (lblDef) lblDef.value = '0.00';
        } catch (e) {
            console.error('[inflate3D] Default model load failure:', e);
            setStatus('Load an STL to begin');
            // silent fallback; user can upload manually
        }
    })();
})();


