import {promises as fs} from "fs";
import {createWriteStream, type Dirent} from "node:fs";
import type {SelectableFile} from "~~/schemas/main.dto";
import {MultiPartData} from 'h3'

export async function useFS() {

    let basePath = './public/images'
    // Ensure base path exists so other operations (readDir, readdir, writeFile) don't fail
    try {
        await fs.mkdir(basePath, { recursive: true })
    } catch {
        // ignore errors here; subsequent ops will surface meaningful errors if any
    }

    function getRelativePath(path: string) {
        path = path.replaceAll('..', '')
        if (path.startsWith('/')) {
            return basePath + path
        }
        return basePath + '/' + path
    }

    async function listDirs(path: string) {
        path = getRelativePath(path)
        let dirs = await fs.readdir(path, {withFileTypes: true})
        return dirs.filter(dirent => dirent.isDirectory())

    }

    async function listFiles(path: string) {
        path = getRelativePath(path)
        let files = await fs.readdir(path, {withFileTypes: true})
        return files.filter(dirent => dirent.isFile())
    }

    async function readDir(path: string) {
        path = getRelativePath(path)
        let dirents = await fs.readdir(path, {withFileTypes: true})
        let files = dirents.filter(dirent => dirent.isFile())
        let dirs = dirents.filter(dirent => dirent.isDirectory())
        return {files, dirs}
    }

    function parseFileDirEntToSelectableFile(dirents: Dirent[]) {
        let l: SelectableFile[] = []
        for (let i of dirents) {
            let o: SelectableFile = {
                parentPath: i.parentPath,
                name: i.name,
                selectedModel: false,
                selectedImage: false,
                url: parentPathToUrl(i.parentPath, i.name)
            }
            l.push(o)
        }
        return l
    }

    function createFolder(path: string, folderName: string) {
        path = getRelativePath(path)
        fs.mkdir(path + '/' + folderName)
    }

    async function saveFile(path: string, file: MultiPartData) {
        path = getRelativePath(path)
        // Ensure destination directory exists
        await fs.mkdir(path, { recursive: true })
        let savedFile = await fs.writeFile(path + '/' + file.filename, file.data,)
        return savedFile
    }

    async function deleteFileOrFolder(path: string) {
        path = getRelativePath(path)
        await fs.rm(path, {recursive: true})
        return true
    }

    function parentPathToUrl(parentPath: string, name: string) {
        return `${parentPath.replace('./public', '')}/${name}`
    }

    async function getFile(path:string){
        // image arrays have image in the already
        path = './public'+ path
        return await fs.readFile(path)
    }

    return {
        listDirs,
        listFiles,
        readDir,
        parentPathToUrl,
        parseFileDirEntToSelectableFile,
        createFolder,
        saveFile,
        deleteFileOrFolder,
        rootFS: fs,
        getFile
    }
}