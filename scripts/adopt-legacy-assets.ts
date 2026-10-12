import {parseArgs} from 'node:util'
import {adoptLegacyAssets} from './lib/legacyAssetAdoption.ts'
import {closeDatabasePool} from '../server/utils/lib/db.ts'
import {closeImageStorage, useFS} from '../server/utils/useFS.ts'

try {
    const {values} = parseArgs({options: {
        'organization-id': {type: 'string'}, 'owner-id': {type: 'string'}, 'max-entries': {type: 'string', default: '1000'},
        apply: {type: 'boolean', default: false}, 'confirm-owner-id': {type: 'string'},
    }})
    if (!values['organization-id'] || !values['owner-id'] || (values.apply && values['confirm-owner-id'] !== values['owner-id'])) {
        throw new Error('Pass --organization-id <uuid> --owner-id <uuid>; adoption defaults to a read-only plan. Applying requires --apply --confirm-owner-id <same uuid>.')
    }
    console.log(JSON.stringify(await adoptLegacyAssets({organizationId: values['organization-id'], ownerUserId: values['owner-id'],
        maxEntries: Number(values['max-entries']), apply: values.apply, storage: await useFS()})))
} catch {
    console.error('Legacy asset adoption failed. Check the explicit owner, entry limit, storage and database configuration; no driver details are logged.')
    process.exitCode = 1
} finally {closeImageStorage(); await closeDatabasePool()}
