const fs = require("fs");
const readline = require("readline");
const { spawn } = require("child_process");
const { off } = require("process");
const { Canvas, loadFont } = require('skia-canvas');

// createCanvas replacement
function createCanvas(width, height) {
    return new Canvas(width, height);
}
function createCanvas(w, h) { return new Canvas(w, h); }

// registerFont replacement
function registerFont(path, options) {
    loadFont(path, { family: options.family });
}

const cos = Math.cos
const sin = Math.sin
const tan = Math.tan
const arcsin = Math.asin
const arccos = Math.acos
const arctan2 = Math.atan2
const PI = Math.PI

// === GLOBALS ===
let startTime = Date.now();
const starCount = 300
const objRadDispMult = 5
const GRAV = 3e-6
const pathLimit = 20
const numFrames = 360; // adjust as needed
const debug = true
const gravSteps = 1000
const zoom = [30,1,0.03]
const speed = 2
const center = ["Pyrinas","X","X"]
let t = 0;

// === CANVAS DIMENSIONS ===
const width = 1000;
const height = 1000;

// === CONFIGURATION ===
const frameRate = 30; // frames per second
const inputFile = "initial.json";
const outputFile = "system.mp4";

// === CANVAS SETUP ===
const canvas = createCanvas(width, height);
const ctx = canvas.getContext("2d");

// === DRAW MAP FOR REUSE EACH FRAME ===
const mapCanvas = createCanvas(width, height);
const mapCtx = mapCanvas.getContext("2d");
mapCtx.fillStyle = "black";
mapCtx.fillRect(0, 0, width, height);
for (let i = 0; i < starCount; i++) {
    const size = Math.random() * 5
    const position = [Math.random() * width, Math.random() * height]
    const brighness = Math.round(Math.random() * 255)
    mapCtx.fillStyle = `rgb(${brighness},${brighness},${brighness})`
    mapCtx.beginPath();
    mapCtx.arc(position[0], position[1], size / 2, 0, PI * 2);
    mapCtx.fill();
}
const mapImage = mapCanvas;

// === START FFMPEG ===
const ffmpegPath = 'C:\\ffmpeg-8.0-full_build\\ffmpeg-8.0-full_build\\bin\\ffmpeg.exe';

// Try NVENC first when available, otherwise libx264 with all cores
let ffmpegArgsNV = [
    '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba',
    '-video_size', `${width}x${height}`,
    '-framerate', String(frameRate),
    '-i', '-',
    '-c:v', 'h264_nvenc',
    '-preset', 'llhq',
    '-rc', 'vbr_hq',
    '-cq', '18',
    '-b:v', '0',
    '-r', String(frameRate),
    outputFile
];

let ffmpegArgsCPU = [
    '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba',
    '-video_size', `${width}x${height}`,
    '-framerate', String(frameRate),
    '-i', '-',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-threads', '0',       // use all cores
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-r', String(frameRate),
    outputFile
];

let ffmpeg;
try {
    // attempt NVENC; if it fails ffmpeg process will error and we can fallback
    ffmpeg = spawn(ffmpegPath, ffmpegArgsNV);
} catch (e) {
    ffmpeg = spawn(ffmpegPath, ffmpegArgsCPU);
}

ffmpeg.stderr.on('data', d => {
    console.error('ffmpeg stderr:', d.toString());
});
ffmpeg.on('error', err => {
    console.error('ffmpeg error:', err);
});
ffmpeg.stdin.on('error', err => {
    if (err.code !== 'EPIPE') console.error('ffmpeg stdin error:', err);
});


// === OBJECT INITIALIZATION ===

let objects = {}
let input = JSON.parse(fs.readFileSync(inputFile, "utf8"))
const objNames = Object.keys(input)
for (const name of objNames) {
    const object = input[name]
    if (object.type!="star") {
        object.initA = Math.random()*2*PI
    }
    // object.initA = 2*PI*0.75
    if (String(object.type).includes("moon")) {
        objects[name] = {
            type: "moon",
            color: object.color,
            radius: object.radius,
            mass: object.mass,
            x: object.initR*cos(object.initA) + objects[object.orbit].x,
            y: object.initR*sin(object.initA) + objects[object.orbit].y,
            vx: object.initV*sin(object.initA) + objects[object.orbit].vx,
            vy: object.initV*-cos(object.initA) + objects[object.orbit].vy,
            path: {}
        }
    } else {
        objects[name] = {
            type: object.type,
            color: object.color,
            radius: object.radius,
            mass: object.mass,
            x: object.initR*cos(object.initA),
            y: object.initR*sin(object.initA),
            vx: object.initV*sin(object.initA),
            vy: object.initV*-cos(object.initA),
            path: {}
        }
    }
    console.log(name + "loaded")
}
let centerX = 0;
let centerY = 0;


// === GENERATE FRAMES ===
function writeFrame(ffmpeg, frameBuffer) {
    return new Promise((resolve, reject) => {
        if (ffmpeg.stdin.destroyed || ffmpeg.stdin.writableEnded) return resolve();
        try {
            if (!ffmpeg.stdin.write(frameBuffer)) {
                ffmpeg.stdin.once('drain', resolve);
            } else {
                resolve();
            }
        } catch (err) {
            if (err && err.code === 'ERR_STREAM_WRITE_AFTER_END') return resolve();
            reject(err);
        }
    });
}

async function checkOffscreen(x,y,j) {
    if (x>1000+1000*j || x<1000*j || y>1000 || y<0) {
        return true
    } else {
        return false
    }
}
let j;
let rem;
(async () => {
    for (let frameCount = 0; frameCount < numFrames; frameCount++) {
        // === PHYSICS CALCULATIONS ===
        if (!frameCount == 0) {
            // = Gravity =
            let speedMult = (10**Math.floor(((frameCount-30)*3)/(numFrames)))
            j = Math.floor(((frameCount-30)*3)/(numFrames))
            rem = (((frameCount-30)*3)/(numFrames))%1*4-3
            if (rem > 0 && j+1 < zoom.length) {
                speedMult = Math.floor(speedMult*(10**rem))
            }
            if (speedMult<1) speedMult = 1
            t += speed * speedMult
            for (let i = 0; i < gravSteps * speed * speedMult; i++) {
                for (const name of objNames) {
                    const object = objects[name]
                    for (const name2 of objNames) {
                        const object2 = objects[name2]
                        if (name === name2) continue; // Skip self-interaction
                        // if (object.type == "star" && object2.type!="star") continue;
                        const dx = object2.x - object.x;
                        const dy = object2.y - object.y;
                        const distSq = dx * dx + dy * dy;
                        
                        if (distSq === 0) continue; // Avoid division by zero
                        
                        const gMag = GRAV * object.mass * object2.mass / distSq / object.mass
                        const angle = arctan2(dy, dx);
                        
                        object.vx += gMag * cos(angle) / gravSteps;
                        object.vy += gMag * sin(angle) / gravSteps;
                    }
                    object.x += object.vx / gravSteps
                    object.y += object.vy / gravSteps
                }
            }
            // = Path =
            for (const name of objNames) {
                const object = objects[name]
                object.path[String(frameCount)] = {
                    x: object.x,
                    y: object.y
                }
                if (object.path[String(frameCount-pathLimit)]) {
                    delete object.path[String(frameCount-pathLimit)]
                }
            }
        }

        // === DRAW FRAME ===
        ctx.fillStyle = "black";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(mapImage, 0, 0);

        // === OBJECT RENDERING ===
        j = Math.floor(((frameCount-30)*3)/(numFrames))
        rem = (((frameCount-30)*3)/(numFrames))%1*4-3
        if (j<0) {
            j=0
            rem = 0
        }
        if (Object.keys(objects).includes(center[j])) {
            centerX = -objects[center[j]].x*5*zoom[j]
            centerY = -objects[center[j]].y*5*zoom[j]
        } else {
            centerX = 0
            centerY = 0
        }
        let frameZoom = zoom[j]
        if (rem > 0 && j+1 < zoom.length) {
            if (Object.keys(objects).includes(center[j+1])) {
                centerX = centerX*(1-rem) + -objects[center[j+1]].x*5*zoom[j+1]*(rem)
                centerY = centerY*(1-rem) + -objects[center[j+1]].y*5*zoom[j+1]*(rem)
            } else {
                centerX = centerX*(1-rem)
                centerY = centerY*(1-rem)
            }
            frameZoom = zoom[j]*(1-rem) + zoom[j+1]*rem
        }
        console.log(frameCount, Math.hypot(centerX, centerY), frameZoom)
        let xOffset = 500 + centerX
        let yOffset = 500 + centerY
        let x;
        let y;
        for (const name of objNames) {
            const object = objects[name]
            const pathFrames = Object.keys(object.path)
            if (pathFrames.length > 0) {
                ctx.strokeStyle = 'white'
                ctx.beginPath()
                let started = false
                // const firstFrame = object.path[pathFrames[0]]
                // ctx.moveTo(firstFrame.x * 5 * zoom[j] + xOffset, firstFrame.y * 5 * zoom[j] + yOffset)
                for (let i = 0; i < pathFrames.length; i++) {
                    const alpha = i / pathFrames.length
                    ctx.globalAlpha = alpha
                    ctx.lineWidth = 1
                    x = object.path[pathFrames[i]].x * 5 * frameZoom + xOffset
                    y = object.path[pathFrames[i]].y * 5 * frameZoom + yOffset
                    // if (await checkOffscreen(x,y,j)) continue;
                    if (!started) {
                        ctx.moveTo(x, y)
                        started = true
                        continue
                    }
                    ctx.lineTo(x, y)
                    ctx.stroke()
                    ctx.beginPath()
                    ctx.moveTo(x, y)
                }
                ctx.globalAlpha = 1
            }
            ctx.fillStyle = object.color
            x = object.x * 5 * frameZoom + xOffset
            y = object.y * 5 * frameZoom + yOffset
            // if (await checkOffscreen(x,y,j) == false) {
                ctx.beginPath()
                ctx.arc(x, y, object.radius*objRadDispMult, 0, PI * 2)
                ctx.fill()
            // }
        }

        // // === DIVIDING LINES ===
        // ctx.strokeStyle = "white"
        // ctx.lineWidth = 2
        // ctx.beginPath()
        // ctx.moveTo(1000, 0)
        // ctx.lineTo(1000, 1000)
        // ctx.stroke()
        // ctx.beginPath()
        // ctx.moveTo(2000, 0)
        // ctx.lineTo(2000, 1000)
        // ctx.stroke()

        // === DEBUG ===
        // if (debug) {
        //     let i = 0
        //     for (const name of objNames) {
        //         i++;
        //         const object = objects[name]
        //         ctx.fillStyle = object.color
        //         ctx.fillText(name,20, 20*i+10)
        //         ctx.fillText(object.mass, 70, 20*i+10)
        //         ctx.fillText(object.x,100, 20*i+10)
        //         ctx.fillText(object.y,250, 20*i+10)
        //     }
        // }
        ctx.fillStyle = "white"
        ctx.font = "40px Arial";
        ctx.fillText(`Frame: ${frameCount+1}/${numFrames}`, 20, 40)
        // One year = t = 4600, 460 days/ year so 1 day = 10t, 20hrs/ day so 1 hr = 0.5t
        ctx.fillText(`Year ${Math.floor(t/4600)}, Day ${Math.floor((t%4600)/10)%460}, Hour ${Math.floor((t%10)/0.5)%20}`, 20, 80)

        let frameBuffer = null;
        try {
            const imageData = ctx.getImageData(0, 0, width, height);
            if (imageData && imageData.data && imageData.data.buffer) {
                frameBuffer = Buffer.from(imageData.data.buffer);
            }
        } catch (e) {
            // ignore
        }

        if (!frameBuffer && typeof canvas.toBuffer === 'function') {
            try {
                frameBuffer = canvas.toBuffer('raw');
            } catch (e) {
                frameBuffer = null;
            }
        }

        if (frameBuffer && frameBuffer.length === width * height * 4) {
            await writeFrame(ffmpeg, frameBuffer);
        }
    }

    console.log('Frame generation complete — total frames:', numFrames);
    ffmpeg.stdin.end();
})();

ffmpeg.on("close", code => {
    if (code === 0) {
        console.log(`✅ Video saved as ${outputFile} in ${(Date.now() - startTime) / 1000}s`);
    } else {
        console.error(`❌ ffmpeg exited with code ${code}`);
    }
});