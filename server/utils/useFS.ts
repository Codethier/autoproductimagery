import {promises as fs} from "fs";

export async function useFS() {

    let basePath = './public/images'

    function getRelativePath(path: string) {
        path = path.replaceAll('..','')
        if (path.startsWith('/')) {
            return basePath + path
        }
        return basePath + '/' + path
    }

    async function listDirs(path: string) {
        path = getRelativePath(path)
        let dirs = await fs.readdir(path,{withFileTypes:true})
        return dirs.filter(dirent => dirent.isDirectory())

    }

    async function listFiles(path: string) {
        path = getRelativePath(path)
        let files = await fs.readdir(path,{withFileTypes:true})
        return files.filter(dirent => dirent.isFile())
    }

    async function readDir(path:string){
        path = getRelativePath(path)
        let dirents = await fs.readdir(path,{withFileTypes:true})
        let files  = dirents.filter(dirent => dirent.isFile())
        let dirs = dirents.filter(dirent => dirent.isDirectory())
        return {files,dirs}
    }

    return {listDirs, listFiles,readDir}
}