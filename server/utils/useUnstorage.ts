// import {createStorage} from "unstorage";
// import fsDriver from "unstorage/drivers/fs";
//
// export function useUnstorage() {
//     const storage = createStorage({driver: fsDriver({base: "./public/images",})})
//
//     // expects a path like "myfolder:myfile.png" there is no need for starting : or ending :
//     // has no concept of folders, which is fine just make new folders on the frontend
//     // always take in paths with : or / and output with :
//
//
//     async function getItems(key: string) {
//         return await storage.getKeys(key)
//     }
//
//     async function getRelativeKeys(key: string) {
//         //     used to get the relative keys from the full path
//         // expects myfolder:mysecondfolder or myfolder/mysecondfolder
//         let allKeys = await storage.getKeys(key)
//         if (key.startsWith('/') || key.startsWith(':')) {
//             key = key.slice(1)
//         }
//         key = key.replaceAll('/', ':')
//         let relativeKeys = []
//         for (let i of allKeys) {
//             if (i.startsWith(key)) {
//                 relativeKeys.push(i.replace(key + ':', ''))
//             }
//         }
//         return {key: key, relativeKeys: relativeKeys}
//     }
//
//     async function getFolders(key: string) {
//         let relativeOBJ = await getRelativeKeys(key)
//         //     if only has one : then it is a relative folder
//         let folders = []
//         for (let i of relativeOBJ.relativeKeys) {
//             const first = i.indexOf(":");
//             if (first === -1) continue;
//             const last = i.lastIndexOf(":");
//             if (first !== last) continue // more than one colon
//             folders.push(i.slice(0, first));
//         }
//         folders = [...new Set(folders)]
//         folders.sort()
//         let finalFolders = []
//         for (let i of folders) {
//             finalFolders.push(relativeOBJ.key + ':' + i)
//         }
//         return finalFolders
//     }
//
//     async function getFiles(key: string) {
//         let relativeOBJ = await getRelativeKeys(key)
//         //     if it has no : then it is a file
//         let files = []
//         for (let i of relativeOBJ.relativeKeys) {
//             const first = i.indexOf(":");
//             if (first === -1) {
//                 files.push(i)
//             }
//         }
//         files = [...new Set(files)]
//         files.sort()
//         let finalFiles = []
//         for (let i of files) {
//             finalFiles.push(relativeOBJ.key + ':' + i)
//         }
//         return {relativeKeys: files, fullFiles: finalFiles}
//     }
//
//
//     return {getItems, getFolders,getFiles, getRelativeKeys}
// }