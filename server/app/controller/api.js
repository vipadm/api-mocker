const R = require('ramda')
const util = require('../util.js')
const assert = require('http-assert')
const mongoose = require('mongoose')

module.exports = app => {
    class ApiController extends app.Controller {
        * getAll () {
            const { groupId } = this.ctx.params
            let { limit = 30, page = 1, order = false, q = '.*'} = this.ctx.query
            page = Number(page)
            limit = Number(limit)
            const reg = new RegExp(`.*${q}.*`, 'i')
            const condition = {
                isDeleted: false,
                "$or": [
                    {name: reg},
                    {url: reg},
                    {desc: reg},
                    {prodUrl: reg},
                    {'options.method': reg},
                ]
            }
            // 超过三个字符才会去匹配api创建者
            const users = (q && q.length > 2) ? yield this.service.user.find(q) : []
            if (users.length) {
                condition.$or.push({
                    creator: {
                        $in: users.map(u => u._id)
                    }
                })
            }
            if (groupId) condition.group = groupId
            const resources = yield this.service.api.geiRichList(condition, page, limit)
            const count = yield app.model.api.find(condition).count().exec()
            this.ctx.logger.info('getAll', this.ctx.query)
            this.ctx.body = { resources, pages: { limit, page, count}}
            this.ctx.status = 200
        }
        * modifyApi () {
            const { groupId, apiId } = this.ctx.params
            const { body } = this.ctx.request
            const authId = this.ctx.authUser._id
            const lastModifiedTime = body.modifiedTime

            assert(mongoose.Types.ObjectId.isValid(groupId), 403, 'invalid groupId')
            assert(mongoose.Types.ObjectId.isValid(apiId), 403, 'invalid apiId')

            delete body._id

            // Hack方法。如果api没有管理员，那本次更新操作的人将成为管理员
            if (!body.manager) body.manager = authId
            const resources = (yield this.service.api.update(apiId, body)).toObject() // 使用lean()方法会导致无法设定schema的默认值
            if (!resources) {
                this.error({
                    code: '500',
                    msg: '系统错误，保存失败'
                })
            }
            yield this.notifyApiChange(resources, lastModifiedTime)
            this.service.group.updateTime(groupId)
            // 存下历史记录，并将所有记录返回
            resources.history = yield this.service.apiHistory.push(resources)

            this.ctx.logger.info('modifyApi', body)
            this.ctx.body = { resources }
        }
        * notifyApiChange(api, lastModifiedTime) {
            // 十分钟内有修改不推送
            const interval = api.modifiedTime - lastModifiedTime
            if (interval < 1000 * 60 * 10) {
                return
            }
            const selfIdx = api.follower.findIndex(f => f.toString() === this.ctx.authUser._id)
            // 如果修改者也在关注列表中，不推送自己
            if (selfIdx >= 0) {
                api.follower.splice(selfIdx, 1)
            }
            console.log(api.follower)
            const users = yield this.service.user.getByIds(api.follower)
            this.service.email.notifyApiChange(api, users)
        }
        * getApi () {
            const { groupId, apiId } = this.ctx.params

            assert(mongoose.Types.ObjectId.isValid(groupId), 403, 'invalid groupId')
            assert(mongoose.Types.ObjectId.isValid(apiId), 403, 'invalid apiId')

            const resources = (yield app.model.api.findOne({_id: apiId, isDeleted: false})).toObject()
            resources.history = yield this.service.apiHistory.get(resources)

            this.ctx.logger.info('getApi')
            this.ctx.body = { resources }
            this.ctx.status = 200
        }
        * follow () {
            const apiId = this.ctx.params.apiId
            const authId = this.ctx.authUser._id
            const api = (yield this.service.api.getById(apiId)).toObject()
            api.follower = api.follower || []
            const isExist = api.follower.find(f => f.toString() === authId)
            if (isExist) {
                this.ctx.body = api
            } else {
                api.follower.push(authId);
                this.ctx.body = yield this.service.api.update(apiId, {
                    follower: api.follower
                })
            }
        }
        * unfollow () {
            const apiId = this.ctx.params.apiId
            const authId = this.ctx.authUser._id
            const api = (yield this.service.api.getById(apiId)).toObject()
            const index = api.follower.findIndex(f => f.toString() === authId)
            if (index < 0) {
                this.ctx.body = api;
            } else {
                api.follower.splice(index, 1)
                console.log(api.follower)
                this.ctx.body = yield this.service.api.update(apiId, {
                    follower: api.follower
                })
            }
        }
        * getManageApi () {
            let { limit = 100, page = 1} = this.ctx.query
            this.ctx.body = yield this.service.api.getManageList()
        }
        * createApi () {
            const { groupId } = this.ctx.params
            const { body } = this.ctx.request

            assert(mongoose.Types.ObjectId.isValid(groupId), 403, 'invalie groupId')
            assert(body.name, 403, 'required name')
            // assert(body.dsl, 403, 'required dsl')
            // 废弃，不需要url了
            // const nextUrl = yield util.generateApiURL(app)

            const resources = yield this.service.api.create(R.merge(body, {
                group: groupId
            }))

            this.service.group.updateTime(groupId)

            this.ctx.logger.info('createApi', body)
            this.ctx.body = { resources }
            this.ctx.status = 200
        }
        * createGroupApis () {
            const { groupId } = this.ctx.params
            const apis = this.ctx.request.body
            const rs = yield this.service.api.createApis(apis)
            this.service.group.updateTime(groupId)
            this.ctx.body = { apis: rs }
            this.ctx.status = 200
        }
        * delete () {
            const { groupId, apiId } = this.ctx.params

            assert(mongoose.Types.ObjectId.isValid(groupId), 403, 'invalie groupId')
            assert(mongoose.Types.ObjectId.isValid(apiId), 403, 'invalid apiId')

            const rs = yield this.service.api.delete(apiId)
            if (!rs) {
                this.error({
                    code: 403,
                    msg: '无权删除'
                });
            }
            yield app.model.group.update({_id: groupId}, {modifiedTime: Date.now()}, {new: true}).exec()
            this.ctx.logger.info('deleteApi')
            this.ctx.status = 204
        }
    }
    return ApiController
}
