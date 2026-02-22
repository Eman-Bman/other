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
const pathLimit = 200
const numFrames = 600; // adjust as needed
const debug = true
const gravSteps = 3000
const zoom = 1
const speed = 2
const center = "Pyrinas-"

// === CANVAS DIMENSIONS ===
const width = 1000;
const height = 1000;

// === CONFIGURATION ===
const frameRate = 30; // frames per second
const inputFile = "initial.json";
const outputFile = "output.mp4";

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

(async () => {
    for (let frameCount = 0; frameCount < numFrames; frameCount++) {
        // === PHYSICS CALCULATIONS ===
        if (!frameCount == 0) {
            // = Gravity =
            for (let i = 0; i < gravSteps * speed; i++)
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
        if (Object.keys(objects).includes(center)) {
            centerX = -objects[center].x*5*zoom
            centerY = -objects[center].y*5*zoom
        }
        for (const name of objNames) {
            const object = objects[name]
            const pathFrames = Object.keys(object.path)
            if (pathFrames.length > 0) {
                ctx.strokeStyle = 'white'
                ctx.lineWidth = 1
                ctx.beginPath()
                const firstFrame = object.path[pathFrames[0]]
                ctx.moveTo(firstFrame.x * 5 * zoom + 500 + centerX, firstFrame.y * 5 * zoom + 500 + centerY)
                for (const frame of pathFrames) {
                    ctx.lineTo(object.path[frame].x * 5 * zoom + 500 + centerX, object.path[frame].y * 5 * zoom + 500 + centerY)
                }
                ctx.stroke()
            }
            ctx.fillStyle = object.color
            ctx.beginPath()
            ctx.arc(object.x * 5 * zoom + 500 + centerX, object.y * 5 * zoom + 500 + centerY, object.radius*objRadDispMult, 0, PI * 2)
            ctx.fill()
        }

        // === DEBUG ===
        if (debug) {
            let i = 0
            for (const name of objNames) {
                i++;
                const object = objects[name]
                ctx.fillStyle = object.color
                ctx.fillText(name,20, 20*i+10)
                ctx.fillText(object.mass, 70, 20*i+10)
                ctx.fillText(object.x,100, 20*i+10)
                ctx.fillText(object.y,250, 20*i+10)
            }
        }

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