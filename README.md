# Inflate3D

Try it out: [Inflate3D](https://andrewsink.github.io/Inflate3D/)

Inflate3D is a quick way to deform your mesh 3D model by inflating or deflating using a simple slider bar. 

![inflate3D](https://github.com/user-attachments/assets/5d94d9f1-9859-4c34-a96a-0b8caf81a598)

You can adjust the amount and position of the inflation modifier, as well as add a flat base to the model. 

![demo3](https://github.com/user-attachments/assets/2a022760-7388-4c20-9305-c9c1a659f3cc)

Toggle the "Flat Base" to give the 3D model a flat base, ideal for 3D printing. 

![demo2](https://github.com/user-attachments/assets/5102b473-d16c-430a-b56c-e94266f8a54e)


## Attributions

This project builds on excellent open‑source work. Thank you to the authors and maintainers of the following projects:

- Three.js (and Three.js Examples: `OrbitControls`, `TransformControls`, `STLLoader`, `STLExporter`)
  - License: MIT
  - Repository: https://github.com/mrdoob/three.js
  - CDN: `https://unpkg.com/three@0.140.0/`

- Tailwind CSS (for the lightweight UI styling via the CDN build)
  - License: MIT
  - Website: https://tailwindcss.com
  - CDN: `https://cdn.tailwindcss.com`

- Inflate/Deflate algorithm inspiration
  - The deformation math is adapted from the "Bloat" modifier concept from the `three.modifiers` project.
  - Package: https://www.npmjs.com/package/three.modifiers
  - License: MIT (see the package for details)

All third‑party libraries are used under their respective licenses.
