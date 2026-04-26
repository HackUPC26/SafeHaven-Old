// // import { NativeModules } from 'react-native';
// const { getDefaultConfig } = require('expo/metro-config')
// const { NativeModules } = require('react-native')



// const config = getDefaultConfig(__dirname)

// // Disable package-exports resolution to silence the react-native-webrtc
// // event-target-shim warning. Metro falls back to file-based resolution,
// // which is what we want and what was already working.
// config.resolver.unstable_enablePackageExports = false

// // Ensure Metro can import the bare-pack output (.bundle.mjs) — which is just
// // a default-exported string — and treat it as a regular source module.
// console.log('[config] scripURL = ', NativeModules?.SourceCode?.scriptURL)
// if (!config.resolver.sourceExts.includes('mjs')) {
//   config.resolver.sourceExts.push('mjs')
// }
// console.log('[config] EXPO_PUBLIC_SIGNAL_HOST env = ', process.env.EXPO_PUBLIC_SIGNAL_HOST)

// module.exports = config
