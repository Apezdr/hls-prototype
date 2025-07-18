// utils/codecReferenceUtils.js
const fsPromises = require('fs').promises;
const path = require('path');
const { HLS_OUTPUT_DIR, VARIANTS } = require('../config/config');
const { safeFilename, ensureDir } = require('./files');
const { getMediaInfo } = require('./ffprobe');
const { resolveCodec } = require('./codecSelection');

// Keep track of in-progress codec reference generations to prevent duplicate work
const inProgressCodecRefs = new Map();

/**
 * Generate a codec reference file for a video and its variants
 * @param {string} videoId - Video identifier
 * @param {string} videoPath - Path to the source video
 * @param {Array<Object>} variants - Array of variant objects
 * @returns {Promise<string>} - Path to the generated codec reference file
 */
async function generateCodecReference(videoId, videoPath, variants = []) {
  // First create the root output directory for this media if it doesn't exist
  const mediaDir = path.join(HLS_OUTPUT_DIR, safeFilename(videoId));
  await ensureDir(mediaDir);
  
  const codecReferencePath = path.join(mediaDir, 'codec_reference.json');
  
  // Check if a generation is already in progress for this videoId
  if (inProgressCodecRefs.has(videoId)) {
    console.log(`Codec reference generation already in progress for ${videoId}, waiting for completion...`);
    try {
      // Wait for the existing generation to complete
      await inProgressCodecRefs.get(videoId);
      console.log(`Existing codec reference for ${videoId} completed, returning reference path`);
      return codecReferencePath;
    } catch (err) {
      console.error(`Error waiting for existing codec reference generation: ${err.message}`);
      // Continue to try again
    }
  }
  
  // Use a more robust check for file existence and validity
  try {
    const stats = await fsPromises.stat(codecReferencePath);
    if (stats.size > 0) {
      try {
        // Try to parse the existing file to make sure it's valid
        const data = await fsPromises.readFile(codecReferencePath, 'utf8');
        const existingReference = JSON.parse(data);
        
        // Verify the file has the expected structure and data
        if (existingReference && 
            existingReference.variants && 
            Object.keys(existingReference.variants).length > 0) {
          console.log(`Using existing codec reference with ${Object.keys(existingReference.variants).length} variants`);
          return codecReferencePath;
        }
      } catch (parseErr) {
        console.log(`Existing codec reference file is invalid, regenerating: ${parseErr.message}`);
      }
    }
  } catch (err) {
    // File doesn't exist or can't be accessed, generate it
    console.log(`Codec reference file not found: ${err.message}`);
  }
  
  // Create a promise for this generation and register it
  const generationPromise = (async () => {
    try {
      console.log(`Generating codec reference file for ${videoId} at ${codecReferencePath}`);
      
      // Get media info for the source video
      const mediaInfo = await getMediaInfo(videoPath);
      
      // Process all possible variants to determine codec for each
      const variantData = {};
      
      // Always use all variants from config + any passed variants to ensure complete reference
      let variantsToProcess = [...VARIANTS];
      
      // Add any additional variants if provided
      if (variants && variants.length > 0) {
        // Add only variants that don't already exist in VARIANTS, with case-insensitive comparison
        for (const variant of variants) {
          const existingVariant = variantsToProcess.find(
            v => v.label.toLowerCase() === variant.label.toLowerCase()
          );
          if (!existingVariant) {
            variantsToProcess.push(variant);
          }
        }
      }
      
      // If source is 4K, add a 4K variant if not already present
      try {
        const videoStream = (mediaInfo.streams || []).find(s => s.codec_type === 'video');
        if (videoStream && videoStream.width >= 3840) {
          // Case-insensitive check for existing 4K variant
          const has4K = variantsToProcess.some(v => 
            v.label.toLowerCase() === '4k'
          );
          if (!has4K) {
            console.log('Adding 4K variant to codec reference');
            variantsToProcess.push({ 
              resolution: `${videoStream.width}x${videoStream.height}`, 
              bitrate: '16000k', 
              label: '4K', 
              isSDR: false, 
              codec: 'source' 
            });
          }
        }
      } catch (err) {
        console.error('Error checking for 4K source:', err);
      }
      
      console.log(`Processing ${variantsToProcess.length} variants for codec reference`);
      
      // Process each variant from combined list
      for (const variant of variantsToProcess) {
        let resolvedCodecName;
        try {
          resolvedCodecName = await resolveCodec(
            variant.codec || 'auto',
            mediaInfo,
            variant
          );
        } catch (err) {
          console.error(`Error resolving codec for variant ${variant.label}: ${err.message}`);
          resolvedCodecName = 'h264'; // Default to h264 if resolution fails
        }
        
        variantData[variant.label] = {
          resolvedCodec: resolvedCodecName,
          extension: getSegmentExtensionForCodec(resolvedCodecName)
        };
      }
      
      // Create the reference object
      const reference = {
        videoId,
        sourceFile: videoPath,
        generatedAt: new Date().toISOString(),
        variants: variantData
      };
      
      // Write the reference file
      await fsPromises.writeFile(codecReferencePath, JSON.stringify(reference, null, 2));
      console.log(`Codec reference file generated at ${codecReferencePath}`);
      
      return codecReferencePath;
    } catch (err) {
      console.error(`Error generating codec reference: ${err.message}`);
      throw err;
    } finally {
      // Always clean up the in-progress tracking, even if there was an error
      inProgressCodecRefs.delete(videoId);
    }
  })();
  
  // Register this generation
  inProgressCodecRefs.set(videoId, generationPromise);
  
  // Wait for generation to complete and return the result
  return await generationPromise;
}

/**
 * Get segment file extension based on codec
 * @param {string} codec - Codec name (e.g., 'hevc', 'h264')
 * @returns {string} - File extension ('m4s' for HEVC, 'ts' for others)
 */
function getSegmentExtensionForCodec(codec) {
  // HEVC requires fMP4 segments
  return codec === 'hevc' ? 'm4s' : 'ts';
}

/**
 * Read the codec reference file for a video
 * @param {string} videoId - Video identifier
 * @returns {Promise<Object>} - The codec reference object
 */
async function getCodecReference(videoId) {
  const codecReferencePath = path.join(HLS_OUTPUT_DIR, safeFilename(videoId), 'codec_reference.json');
  
  // If there's a generation in progress, wait for it
  if (inProgressCodecRefs.has(videoId)) {
    try {
      await inProgressCodecRefs.get(videoId);
    } catch (err) {
      console.error(`Error waiting for in-progress codec reference generation: ${err.message}`);
      // Continue to try reading the file anyway
    }
  }
  
  try {
    const data = await fsPromises.readFile(codecReferencePath, 'utf8');
    const reference = JSON.parse(data);
    
    // Basic validation
    if (!reference.variants || Object.keys(reference.variants).length === 0) {
      throw new Error(`Invalid codec reference format for ${videoId}`);
    }
    
    return reference;
  } catch (err) {
    throw new Error(`Codec reference file not found or invalid for ${videoId}: ${err.message}`);
  }
}

/**
 * Get the segment extension for a specific variant
 * @param {string} videoId - Video identifier
 * @param {string} variantLabel - Variant label
 * @returns {Promise<string>} - File extension ('m4s' or 'ts')
 */
async function getSegmentExtensionForVariant(videoId, variantLabel) {
  try {
    const reference = await getCodecReference(videoId);
    
    // Do a case-insensitive search to find the variant
    const matchingVariantKey = findVariantIgnoreCase(reference.variants, variantLabel);
    
    // Check if we found a matching variant
    if (matchingVariantKey) {
      return reference.variants[matchingVariantKey].extension;
    }
    
    // If variant not found, return default extension
    console.warn(`Variant ${variantLabel} not found in codec reference for ${videoId}, using default extension`);
    return 'ts';
  } catch (err) {
    console.error(`Error getting segment extension for variant: ${err.message}`);
    // Default to 'ts' if any error occurs
    return 'ts';
  }
}

/**
 * Get the resolved codec for a specific variant
 * @param {string} videoId - Video identifier
 * @param {string} variantLabel - Variant label
 * @returns {Promise<string>} - Resolved codec name (e.g., 'h264', 'hevc')
 */
async function getResolvedCodecForVariant(videoId, variantLabel) {
  try {
    const reference = await getCodecReference(videoId);
    
    // Do a case-insensitive search to find the variant
    const matchingVariantKey = findVariantIgnoreCase(reference.variants, variantLabel);
    
    // Check if we found a matching variant
    if (matchingVariantKey) {
      return reference.variants[matchingVariantKey].resolvedCodec;
    }
    
    // If variant not found, return default codec
    console.warn(`Variant ${variantLabel} not found in codec reference for ${videoId}, using default codec`);
    return 'h264';
  } catch (err) {
    console.error(`Error getting resolved codec for variant: ${err.message}`);
    // Default to 'h264' if any error occurs
    return 'h264';
  }
}

/**
 * Helper function to find a variant key in a case-insensitive manner
 * @param {Object} variants - Object containing variant data
 * @param {string} searchLabel - Variant label to search for
 * @returns {string|null} - The matching variant key, or null if not found
 */
function findVariantIgnoreCase(variants, searchLabel) {
  // Convert search label to lowercase for comparison
  const searchLabelLower = searchLabel.toLowerCase();
  
  // Look for an exact match first (maintaining backward compatibility)
  if (variants[searchLabel]) {
    return searchLabel;
  }
  
  // If no exact match, try case-insensitive search
  for (const key of Object.keys(variants)) {
    if (key.toLowerCase() === searchLabelLower) {
      console.log(`Found case-insensitive match for variant: ${searchLabel} → ${key}`);
      return key;
    }
  }
  
  // No match found
  return null;
}

module.exports = {
  generateCodecReference,
  getCodecReference,
  getSegmentExtensionForVariant,
  getResolvedCodecForVariant,
  getSegmentExtensionForCodec,
  findVariantIgnoreCase
};
