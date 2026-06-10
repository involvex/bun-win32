/**
 * Blur — GPU image processing in a ten-line kernel: upload pixels, separately blur
 * them on the GPU, save before/after PNGs.
 *
 * Synthesizes a colorful test card (color wheel + checkerboard + circles), uploads
 * it with textureFromPixels, runs a 9×9 box blur as a compute shader reading a
 * Texture2D and writing a RWTexture2D, reads the result back RowPitch-correctly,
 * and writes both images as PNGs with the pure-TS encoder.
 *
 * APIs demonstrated:
 * - textureFromPixels (CPU pixels → GPU texture via UpdateSubresource)
 * - makeTexture (RWTexture2D UAV output)
 * - compile / makeComputeShader / csSet / dispatch (image-processing kernel)
 * - readbackTexture (RowPitch-correct readback)
 * - encodePNG (pure-TS PNG output)
 *
 * Run: bun run example/blur.ts
 */
import { comRelease, compile, createComputeDevice, csSet, destroyDevice, dispatch, encodePNG, makeComputeShader, makeTexture, readbackTexture, textureFromPixels } from '@bun-win32/gpu';

const W = 512;
const H = 320;

const pixels = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const offset = (y * W + x) * 4;
    const angle = Math.atan2(y - H / 2, x - W / 2);
    const radius = Math.hypot(x - W / 2, y - H / 2);
    const checker = (Math.floor(x / 24) + Math.floor(y / 24)) % 2;
    const ring = Math.abs(Math.sin(radius * 0.08)) > 0.85 ? 255 : 0;
    pixels[offset] = Math.round(127 + 127 * Math.cos(angle));
    pixels[offset + 1] = Math.round(127 + 127 * Math.cos(angle + 2.094));
    pixels[offset + 2] = checker * 200 + ring;
    pixels[offset + 3] = 255;
  }
}

const gpu = createComputeDevice();
console.log(`blur on ${gpu.gpuName} (${gpu.driver})`);

const source = textureFromPixels(pixels, W, H);
const destination = makeTexture({ w: W, h: H, uav: true });
const blur = makeComputeShader(
  compile(
    `Texture2D<float4> source : register(t0);
     RWTexture2D<float4> destination : register(u0);
     [numthreads(8,8,1)] void main(uint3 id : SV_DispatchThreadID) {
       if (id.x >= W || id.y >= H) return;
       float4 accumulator = 0;
       for (int dy = -4; dy <= 4; dy += 1)
         for (int dx = -4; dx <= 4; dx += 1)
           accumulator += source.Load(int3(clamp(int2(id.xy) + int2(dx, dy), int2(0, 0), int2(W - 1, H - 1)), 0));
       destination[id.xy] = accumulator / 81.0;
     }`,
    'main',
    'cs_5_0',
    { defines: { H, W } },
  ),
);
csSet(blur, { srv: [source.srv!], uav: [destination.uav!] });
dispatch(Math.ceil(W / 8), Math.ceil(H / 8));
csSet(0n, { srv: [0n], uav: [0n] });

const blurred = readbackTexture(destination.tex, W, H);

function rgbaToRgb(rgba: Uint8Array): Uint8Array {
  const rgb = new Uint8Array(W * H * 3);
  for (let index = 0; index < W * H; index += 1) {
    rgb[index * 3] = rgba[index * 4]!;
    rgb[index * 3 + 1] = rgba[index * 4 + 1]!;
    rgb[index * 3 + 2] = rgba[index * 4 + 2]!;
  }
  return rgb;
}

const outputDirectory = Bun.env.BLUR_OUT_DIR ?? `${import.meta.dir}/../.scratch`;
await Bun.write(`${outputDirectory}/blur-before.png`, encodePNG(rgbaToRgb(pixels), W, H));
await Bun.write(`${outputDirectory}/blur-after.png`, encodePNG(rgbaToRgb(blurred), W, H));
console.log(`wrote ${outputDirectory}/blur-before.png and blur-after.png`);

comRelease(destination.uav!);
comRelease(destination.tex);
comRelease(blur);
comRelease(source.srv!);
comRelease(source.tex);
destroyDevice();
