import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';


// ============================================
// 1. SCENE
// ============================================

const scene = new THREE.Scene();

scene.background = new THREE.Color(0xeeeeee);


// ============================================
// 2. CAMERA
// ============================================

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  10000
);

camera.position.set(200, 150, 200);


// ============================================
// 3. RENDERER
// ============================================

const renderer = new THREE.WebGLRenderer({
  antialias: true
});

renderer.setSize(
  window.innerWidth,
  window.innerHeight
);

renderer.setPixelRatio(
  window.devicePixelRatio
);

document.body.appendChild(renderer.domElement);


// ============================================
// 4. ORBIT CONTROLS
// ============================================

const controls = new OrbitControls(
  camera,
  renderer.domElement
);

controls.enableDamping = true;


// ============================================
// 5. LIGHTING
// ============================================

const ambientLight = new THREE.AmbientLight(
  0xffffff,
  2
);

scene.add(ambientLight);


const directionalLight = new THREE.DirectionalLight(
  0xffffff,
  3
);

directionalLight.position.set(
  200,
  300,
  200
);

scene.add(directionalLight);


// ============================================
// 6. COLORS
// ============================================

const DEFAULT_COLOR = 0x2b3037;

const RED_COLOR = 0xff0000;


// ============================================
// 7. COMPONENT DEFINITIONS
// ============================================

const components = {

  Motor_M001: {
    name: 'Motor',
    id: 'M001',
    object: null,
    meshes: [],
    isRed: false
  },

  Shaft_S001: {
    name: 'Shaft',
    id: 'S001',
    object: null,
    meshes: [],
    isRed: false
  },

  Pump_P001: {
    name: 'Pump',
    id: 'P001',
    object: null,
    meshes: [],
    isRed: false
  }

};


// ============================================
// 8. GLTF LOADER
// ============================================

const loader = new GLTFLoader();


let model = null;


// ============================================
// 9. LOAD MODEL
// ============================================

loader.load(

  '/Test.gltf',

  // ------------------------------------------
  // SUCCESS
  // ------------------------------------------

  (gltf) => {

    model = gltf.scene;

    scene.add(model);

    console.log('================================');
    console.log('MODEL LOADED');
    console.log('================================');


    // ------------------------------------------
    // Print complete model structure
    // ------------------------------------------

    model.traverse((object) => {

      console.log(
        'Object:',
        object.name,
        '| Type:',
        object.type
      );

    });


    // ==========================================
    // FIND COMPONENTS
    // ==========================================

    Object.keys(components).forEach(
      (componentKey) => {

        const component =
          components[componentKey];


        // Find the named component object

        component.object =
          model.getObjectByName(componentKey);


        console.log(
          component.name,
          'object:',
          component.object
        );


        // --------------------------------------
        // Find all meshes belonging to component
        // --------------------------------------

        if (component.object) {

          component.object.traverse(
            (child) => {

              if (child.isMesh) {

                // Clone material so each
                // component can have its own color

                if (child.material) {

                  child.material =
                    child.material.clone();

                }

                component.meshes.push(
                  child
                );

              }

            }
          );

        }


        console.log(
          component.name,
          'meshes:',
          component.meshes
        );

      }
    );


    // ==========================================
    // CENTER MODEL
    // ==========================================

    const box =
      new THREE.Box3().setFromObject(model);

    const center =
      box.getCenter(
        new THREE.Vector3()
      );

    model.position.sub(center);


    // ==========================================
    // CAMERA POSITION
    // ==========================================

    const size =
      box.getSize(
        new THREE.Vector3()
      );

    const maxDimension =
      Math.max(
        size.x,
        size.y,
        size.z
      );


    camera.position.set(
      maxDimension * 2,
      maxDimension * 1.5,
      maxDimension * 2
    );


    camera.lookAt(
      0,
      0,
      0
    );


    controls.target.set(
      0,
      0,
      0
    );

    controls.update();


    console.log('================================');
    console.log('COMPONENTS READY');
    console.log('================================');

  },


  // ------------------------------------------
  // LOADING PROGRESS
  // ------------------------------------------

  undefined,


  // ------------------------------------------
  // ERROR
  // ------------------------------------------

  (error) => {

    console.error(
      'Error loading model:',
      error
    );

  }

);


// ============================================
// 10. TOGGLE COMPONENT COLOR
// ============================================

function toggleComponent(componentKey) {

  const component =
    components[componentKey];


  // ------------------------------------------
  // Check component exists
  // ------------------------------------------

  if (!component.object) {

    console.log(
      'Component not loaded:',
      componentKey
    );

    return;

  }


  // ------------------------------------------
  // Check meshes exist
  // ------------------------------------------

  if (component.meshes.length === 0) {

    console.log(
      'No meshes found for:',
      componentKey
    );

    return;

  }


  // ------------------------------------------
  // Toggle state
  // ------------------------------------------

  component.isRed =
    !component.isRed;


  // ------------------------------------------
  // Change every mesh belonging
  // to the component
  // ------------------------------------------

  component.meshes.forEach(
    (mesh) => {

      if (
        mesh.material &&
        mesh.material.color
      ) {

        if (component.isRed) {

          mesh.material.color.set(
            RED_COLOR
          );

        } else {

          mesh.material.color.set(
            DEFAULT_COLOR
          );

        }

      }

    }
  );


  // ------------------------------------------
  // Console information
  // ------------------------------------------

  if (component.isRed) {

    console.log(
      `${component.name} (${component.id}) → RED`
    );

  } else {

    console.log(
      `${component.name} (${component.id}) → DEFAULT`
    );

  }

}


// ============================================
// 11. CREATE COMPONENT MENU
// ============================================

const menu =
  document.createElement('div');


// --------------------------------------------
// Menu position
// --------------------------------------------

menu.style.position = 'absolute';

menu.style.top = '20px';

menu.style.left = '20px';


// --------------------------------------------
// Menu size
// --------------------------------------------

menu.style.width = '180px';

menu.style.padding = '15px';


// --------------------------------------------
// Menu appearance
// --------------------------------------------

menu.style.background =
  'rgba(255, 255, 255, 0.95)';

menu.style.borderRadius =
  '10px';

menu.style.boxShadow =
  '0 4px 15px rgba(0,0,0,0.2)';


// --------------------------------------------
// Font
// --------------------------------------------

menu.style.fontFamily =
  'Arial, sans-serif';

menu.style.zIndex = '100';


// ============================================
// 12. MENU TITLE
// ============================================

const title =
  document.createElement('div');

title.innerText =
  'COMPONENTS';

title.style.fontWeight =
  'bold';

title.style.fontSize =
  '16px';

title.style.marginBottom =
  '12px';

title.style.color =
  '#222';

menu.appendChild(title);


// ============================================
// 13. COMPONENT BUTTONS
// ============================================

Object.keys(components).forEach(
  (componentKey) => {

    const component =
      components[componentKey];


    // ----------------------------------------
    // Create button
    // ----------------------------------------

    const button =
      document.createElement('button');


    button.innerText =
      `${component.name} (${component.id})`;


    // ----------------------------------------
    // Button styling
    // ----------------------------------------

    button.style.display =
      'block';

    button.style.width =
      '100%';

    button.style.marginBottom =
      '8px';

    button.style.padding =
      '9px';

    button.style.border =
      '1px solid #ccc';

    button.style.borderRadius =
      '6px';

    button.style.background =
      '#f5f5f5';

    button.style.cursor =
      'pointer';

    button.style.fontSize =
      '13px';

    button.style.color =
      '#222';


    // ========================================
    // BUTTON CLICK
    // ========================================

    button.addEventListener(
      'click',
      () => {

        toggleComponent(
          componentKey
        );


        // ------------------------------------
        // Update button appearance
        // ------------------------------------

        if (component.isRed) {

          button.style.background =
            '#ff0000';

          button.style.color =
            'white';

          button.style.borderColor =
            '#cc0000';

        } else {

          button.style.background =
            '#f5f5f5';

          button.style.color =
            '#222';

          button.style.borderColor =
            '#ccc';

        }

      }
    );


    menu.appendChild(
      button
    );

  }
);


// ============================================
// 14. ADD MENU TO PAGE
// ============================================

document.body.appendChild(
  menu
);


// ============================================
// 15. ANIMATION LOOP
// ============================================

function animate() {

  requestAnimationFrame(
    animate
  );

  controls.update();

  renderer.render(
    scene,
    camera
  );

}

animate();


// ============================================
// 16. WINDOW RESIZE
// ============================================

window.addEventListener(
  'resize',
  () => {

    camera.aspect =
      window.innerWidth /
      window.innerHeight;


    camera.updateProjectionMatrix();


    renderer.setSize(
      window.innerWidth,
      window.innerHeight
    );

  }
);