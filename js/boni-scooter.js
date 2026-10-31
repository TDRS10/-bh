// Small CSS 3D scene: actual six-sided solids, no external renderer or requests.
(() => {
  const mount = document.getElementById('boniScooterModel');
  const scene = document.getElementById('boniScooterScene');
  const toggle = document.getElementById('boniMotionToggle');
  if (!mount || !scene || !toggle) return;
  function box(x, y, z, w, h, d, color, angle = 0, label = '') {
    const solid = document.createElement('div');
    solid.className = 'boni-solid';
    solid.style.transform = `translate3d(${x}px,${y}px,${z}px) rotateZ(${angle}deg)`;
    const faces = [
      [w,h,`translateZ(${d/2}px)`,1], [w,h,`rotateY(180deg) translateZ(${d/2}px)`,.65],
      [d,h,`rotateY(90deg) translateZ(${w/2}px)`,.8], [d,h,`rotateY(-90deg) translateZ(${w/2}px)`,.55],
      [w,d,`rotateX(90deg) translateZ(${h/2}px)`,1.15], [w,d,`rotateX(-90deg) translateZ(${h/2}px)`,.5]
    ];
    faces.forEach(([width,height,transform,light], index) => {
      const face = document.createElement('div');
      face.className = 'boni-face';
      Object.assign(face.style, {width:width+'px',height:height+'px',marginLeft:-width/2+'px',marginTop:-height/2+'px',transform,background:color,filter:`brightness(${light})`});
      if (label && index < 2) face.textContent = label;
      solid.appendChild(face);
    });
    mount.appendChild(solid);
  }
  function wheel(x) {
    const wheel = document.createElement('div');
    wheel.className = 'boni-wheel';
    wheel.style.transform = `translate3d(${x}px,63px,0)`;
    const rotor = document.createElement('div');
    rotor.className = 'boni-wheel-rotor';
    for (const z of [-13,13]) {
      const face = document.createElement('div');
      face.className = 'boni-wheel-face';
      face.style.transform = `translateZ(${z}px)`;
      rotor.appendChild(face);
    }
    for (let i=0;i<16;i++) {
      const tread = document.createElement('div');
      tread.className = 'boni-tread';
      tread.style.transform = `rotateZ(${i*22.5}deg) translateY(-29px) rotateX(90deg)`;
      rotor.appendChild(tread);
    }
    wheel.appendChild(rotor); mount.appendChild(wheel);
  }
  wheel(-78); wheel(83);
  box(-55,34,0,85,37,45,'#e92240',0,'B'); // rear body
  box(-45,10,0,80,13,49,'#26232c'); // seat
  box(10,51,0,110,10,39,'#bc1934'); // deck
  box(65,9,0,24,85,40,'#ef233c',-16); // front shield
  box(82,45,0,9,40,15,'#9b9fac',-16); // fork
  box(48,-37,0,14,22,25,'#ef233c',-16);
  box(51,-47,0,15,9,84,'#4e505b'); // handlebar
  box(51,-47,43,19,11,16,'#11131a');
  box(51,-47,-43,19,11,16,'#11131a');
  box(68,-29,0,8,15,24,'#fff2ca'); // headlight
  box(-100,29,0,8,13,35,'#ff6473'); // tail light
  box(-88,-16,0,40,43,48,'#1c1e29',0,'BONY'); // delivery box
  box(-17,-23,0,30,53,32,'#ef233c',-9); // jacket
  box(-3,-61,0,32,31,33,'#eee9e9',-7); // helmet
  box(11,-63,0,8,14,35,'#161c29',-7); // visor
  for (const z of [-22,22]) {
    box(22,-39,z,57,12,12,'#b31d36',-8); // arms
    box(47,-43,z,12,12,13,'#292b36'); // gloves
    box(2,8,z,43,17,16,'#262a38',22); // thighs
    box(21,29,z,14,38,15,'#202431',-6); // lower legs
    box(30,47,z,31,12,19,'#d8dbe2'); // shoes
  }
  let paused = false;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  function update() {
    const still = paused || reduced.matches || document.hidden;
    scene.classList.toggle('boni-paused', still);
    toggle.disabled = reduced.matches;
    toggle.setAttribute('aria-pressed', String(paused || reduced.matches));
    toggle.textContent = reduced.matches ? 'الحركة مخفّضة' : paused ? 'تشغيل اللفة ↻' : 'إيقاف الحركة Ⅱ';
  }
  toggle.addEventListener('click', () => { paused = !paused; update(); });
  reduced.addEventListener('change', update);
  document.addEventListener('visibilitychange', update);
  update();
})();
