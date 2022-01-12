#!/usr/bin/env node

import pako from 'pako';
import fetch from 'node-fetch';

// Get the token from camera.map_data entity
const token = "";

// Your home assistant fqdn or ip address with the port if different from default of scheme
const haEndpoint  = "";
const imgURL = `${haEndpoint}/api/camera_proxy/camera.map_data?token=${token}`;

/**
 * This has been adapted for this use-case from https://github.com/hughsk/png-chunks-extract/blob/d098d583f3ab3877c1e4613ec9353716f86e2eec/index.js
 *
 * See https://github.com/hughsk/png-chunks-extract/blob/d098d583f3ab3877c1e4613ec9353716f86e2eec/LICENSE.md for more information.
 */

function extractZtxtPngChunks (data) {
  // Used for fast-ish conversion between uint8s and uint32s/int32s.
  // Also required in order to remain agnostic for both Node Buffers and
  // Uint8Arrays.
  var uint8 = new Uint8Array(4)
  var uint32 = new Uint32Array(uint8.buffer)


  if (data[0] !== 0x89) throw new Error('Invalid .png file header')
  if (data[1] !== 0x50) throw new Error('Invalid .png file header')
  if (data[2] !== 0x4E) throw new Error('Invalid .png file header')
  if (data[3] !== 0x47) throw new Error('Invalid .png file header')
  if (data[4] !== 0x0D) throw new Error('Invalid .png file header: possibly caused by DOS-Unix line ending conversion?')
  if (data[5] !== 0x0A) throw new Error('Invalid .png file header: possibly caused by DOS-Unix line ending conversion?')
  if (data[6] !== 0x1A) throw new Error('Invalid .png file header')
  if (data[7] !== 0x0A) throw new Error('Invalid .png file header: possibly caused by DOS-Unix line ending conversion?')

  var ended = false
  var chunks = []
  var idx = 8

  while (idx < data.length) {
    // Read the length of the current chunk,
    // which is stored as a Uint32.
    uint8[3] = data[idx++]
    uint8[2] = data[idx++]
    uint8[1] = data[idx++]
    uint8[0] = data[idx++]

    // Chunk includes name/type for CRC check (see below).
    var length = uint32[0] + 4
    var chunk = new Uint8Array(length)
    chunk[0] = data[idx++]
    chunk[1] = data[idx++]
    chunk[2] = data[idx++]
    chunk[3] = data[idx++]

    // Get the name in ASCII for identification.
    var name = (
        String.fromCharCode(chunk[0]) +
        String.fromCharCode(chunk[1]) +
        String.fromCharCode(chunk[2]) +
        String.fromCharCode(chunk[3])
    )

    // The IEND header marks the end of the file,
    // so on discovering it break out of the loop.
    if (name === 'IEND') {
      ended = true

      break
    }

    // Read the contents of the chunk out of the main buffer.
    for (var i = 4; i < length; i++) {
      chunk[i] = data[idx++]
    }

    //Skip the CRC32
    idx += 4;

    // The chunk data is now copied to remove the 4 preceding
    // bytes used for the chunk name/type.
    var chunkData = new Uint8Array(chunk.buffer.slice(4))

    if(name === "zTXt") {
      let i = 0;
      let keyword = "";

      while(chunkData[i] !== 0 && i < 79 ) {
          keyword += String.fromCharCode(chunkData[i]);

          i++;
      }

      chunks.push({
        keyword: keyword,
        data: new Uint8Array(chunkData.slice(i + 2))
      });
    }
  }

  if (!ended) {
      throw new Error('.png file ended prematurely: no IEND header was found')
  }

  return chunks
}

function preprocessMapData(mapData) {
  if (mapData.metaData?.version === 2 && Array.isArray(mapData.layers)) {
    mapData.layers.forEach(layer => {
      if(layer.pixels.length === 0 && layer.compressedPixels.length !== 0) {
        for (let i = 0; i < layer.compressedPixels.length; i = i + 3) {
          const xStart = layer.compressedPixels[i];
          const y = layer.compressedPixels[i+1]
          const count = layer.compressedPixels[i+2]

          for(let j = 0; j < count; j++) {
            layer.pixels.push(
                xStart + j,
                y
            );
          }
        }
      }
    })
  }

  return mapData;
}

async function loadImageAndExtractMapData(url) {
  //const response = await Fetch(url);
  const response = await fetch(url);
  let mapData;

  // if(!response.ok) {
  //   throw new Error("Got error while fetching image " + response.status + " - " + response.statusText);
  // }
  const responseData = await response.arrayBuffer();

  const chunks = extractZtxtPngChunks(new Uint8Array(responseData)).filter(c => c.keyword === "ValetudoMap");

  if(chunks.length < 1) {
    throw new Error("No map data found in image");
  }


  mapData = pako.inflate(chunks[0].data, { to: 'string' });
  mapData = JSON.parse(mapData);

  mapData = preprocessMapData(mapData);

  return mapData;
}

const mapData = await loadImageAndExtractMapData(imgURL);

let robotPoints = [];

mapData.entities.map(entity => {
  if (entity.type == "robot_position") {
    // console.log("Robot metadata:");
    // console.log(entity.metaData);
    // console.log("Robot points:");
    // console.log(entity.points);
    robotPoints = entity.points;
  }
});

// mapData.layers.map(layer => {
//   if (layer.type == "floor") {
//     console.log("Floor metadata:");
//     console.log(layer.metaData);
//     console.log("Floor dimensions:");
//     console.log(layer.dimensions);
//     console.log("Floor Pixels:");
//     console.log(layer.pixels);
//   }
// });

let roomName;
let roomArea = 0;
mapData.layers.map(layer => {
  if (layer.type == "segment") {
    // console.log("Floor metadata:");
    // console.log(layer.metaData);
    // console.log("Floor dimensions:");
    // console.log(layer.dimensions);
    // console.log("Floor Pixels:");
    // console.log(layer.pixels);

    if (
      robotPoints[0] && robotPoints[1] &&
      robotPoints[0] >= layer.dimensions.x.min &&
      robotPoints[0] <= layer.dimensions.x.max &&
      robotPoints[1] >= layer.dimensions.y.min &&
      robotPoints[1] <= layer.dimensions.y.max
    ) {
      roomName = layer.metaData.name;
      roomArea = layer.metaData.area;
    }
  }
});

console.log("Room name: %s", roomName);
console.log("Room area: " + roomArea);
