const util = require('util');

const DirectusSDK = require('@directus/sdk-js');
const yaml = require('js-yaml');
const urlslug = require('url-slug');
const fs = require('fs');
const mime = require('mime-types');

const express = require('express')
const bodyParser = require('body-parser');

const uuidregex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

class Driver {
    constructor(config = {}, directusConfig = {}){
        this.url = config.url || 'http://localhost:8055';
        this.email = config.email || '';
        this.password = config.password || '';
        this.frontMatter = (config.frontMatter && config.frontMatter.toUpperCase()) || 'YAML'; // TODO: Add TOML and JSON frontmatter support

        this.content = {}
        this.content.path = (config.content && config.content.path) ? config.content.path : 'content';
        this.content.home = (config.content && config.content.home) ? config.content.home.toLowerCase() : 'home';
        this.content.index = (config.content && config.content.index) ? config.content.index.toLowerCase() : 'index';
        this.content.map = (config.content && config.content.map) ? config.content.map : [];

        this.directus = new DirectusSDK(this.url, directusConfig);

        this.pathMethod = config.pathBuilder || this._pathBuilder;
        this._auth = null;
        
        this.buildDrafts = config.buildDrafts || false;
        // Auto-rebuild server related
        this.buildPort = config.buildPort || 8060;
        this.buildHost = config.buildHost || 'http://localhost';
        this.autoWebhook = config.autoWebhook || true;
    }

    _checkAuth(){
        return new Promise(resolve => {
            if (this.email && this.password && this._auth === null){
                this._auth = this.directus.auth.login({ email: this.email, password: this.password })
                    .then(() => {
                        console.info('Login with user', this.email);
                        resolve()
                    })
            } else {
                resolve()
            }
        })
    }

    static emptyPromise(){
        return new Promise(resolve => resolve())
    }

    getCollections(){
        return this.directus.collections.read()
        // Let not following .then() confuse you. It is an arrow function running an arrow filter.
        // The Directus internal system fields have "meta.system == true" and those we discard here.
        // .then(data => {
        //     console.log(util.inspect(data, false, null, true /* enable colors */))
        //     return data
        // })
        .then(data => data.data.filter(collection => !collection.meta.system))
    }

    /**
     * Build path string where the articles will be stored exlcluding individual article slug
     * @param {*} article 
     * @param {*} collection 
     * @returns {string}
     */
    _pathBuilder(article, collection){
        // console.log(collection);
        console.log(collection);

        if (this._isHome(article, collection)) {
            return `${this.content.path}`;
        }
        if (this._isBranch(article, collection) || this._isPage(article, collection)){
            return `${this.content.path}/${collection.collection}`;
        }
        const datePrefix = article.date_created ? `${article.date_created.split('T')[0]}_` : '';
        return `${this.content.path}/${collection.collection}/${article.id}_${datePrefix}${urlslug(article.title, { remove: /\./g })}`;
    }

    _isHome(article, collection){
        return (collection.meta.singleton === true && collection.collection === this.content.home)
    }

    _isBranch(article, collection){
        return (collection.meta.singleton === false && article.title.toLowerCase() === this.content.index)
    }

    // eslint-disable-next-line class-methods-use-this
    _isPage(article, collection){
        return (collection.meta.singleton === true) 
    }

    _formatFrontMatter(article, collection = {}){
        let front = { ...article };
        
        // Manipulate some variable property names
        if (front.date_created){
            front.date = front.date_created
            delete front.date_created
        }
        if (front.date_updated){
            front.lastmod = front.date_updated
            delete front.date_updated
        }
        delete front.body

        // Finally, transform from object to string
        if (this.frontMatter === 'YAML'){
            front = `---\r\n${yaml.safeDump(front).trim()}\r\n---\r\n`
        }
        return front
    }

    static _writeFileStream(path, readstream, passtrough = {}){
        return new Promise((resolve, reject) => {
            const fileWriter = fs.createWriteStream(path);
            fileWriter.on('finish', () => {
                resolve(passtrough)
            });
            fileWriter.on('error', error => {
                console.log(error)
                fileWriter.close();
                reject(error);
              });
            readstream.pipe(fileWriter);
        });
    }

    /**
     * 
     * @param {object} article
     * @param {object} collection
     * @returns {promise}
     */
    _importItem(originArticle, collection){
        const article = { ...originArticle }
        const itemPath = this.pathMethod(article, collection);
        const indexName = this._isHome(article, collection) || this._isBranch(article, collection) || this._isPage(article, collection) ? '_index' : 'index'

        // Only continue if this is a published article or we have explicitly set to import Drafts
        // Archived items would be always discarded

        if ((article.status === 'archived') || (article.status === 'draft' && this.buildDrafts === false)){
            return Driver.emptyPromise();
        }

        // if ((article.status !== 'published') && (article.status === 'draft' && this.buildDrafts === false)){
        //     return Driver.emptyPromise();
        // }
        
        if (!fs.existsSync(itemPath)){
            fs.mkdirSync(itemPath, { recursive: true });
        }

        const writePromises = []

        for (const [key, value] of Object.entries(article)){
            // TODO: instead of trying to pull asset and hope for the best,
            // crosscheck things with the /fields and play by the rules
            if (typeof value === 'string' && value.match(uuidregex)) {
                console.log([key, value]);
                
                const downloadPromise = this.directus.axios.get(`assets/${value}?download`, { responseType: 'stream' })
                    .then(response => {
                        const disposition = response.headers['content-disposition'].match(/filename="(.*)"/);
                        const downloadName = disposition ? disposition[1] : `${value}.${mime.extension(response.headers['content-type'])}`;
                        const savePath = `${itemPath}/${downloadName}`;
                        return Driver._writeFileStream(savePath, response.data, { key, downloadName })
                    })
                    .then(passtrough => {
                        article[passtrough.key] = passtrough.downloadName
                    })
                    .catch(error => {
                        if (error.response && error.response.status && error.response.status !== 403) {
                            console.error(error.response.status, error.response.statusText)
                        }
                    });
                    writePromises.push(downloadPromise);
            }
        }

        return Promise.all(writePromises).then(() => {
            const frontMatter = this._formatFrontMatter(article, collection);
            const itemContent = `${frontMatter}${article.body ? article.body.toString() : ''}`
            fs.writeFileSync(`${itemPath}/${indexName}.md`, itemContent)
        })
    }

    _importCollection(collection){
        const col = this.directus.items(collection.collection).read() // TODO: IMPORTANT handle pagination when a lot of content in CMS
        return col
            .then(data => {
                // normalize to always have an array of content.
                const content = (collection.meta.singleton === true) ? [data.data] : data.data;
                return content.map(article => this._importItem(article, collection))
            })
    }

    import() {
        console.info('Let\'s import from', this.url);
        this._checkAuth()
            .then(() => this.getCollections())
            .then(collections => {
                // console.log(collections)
                  return collections.map(collection => this._importCollection(collection))
                })
            .then(collectionPromises => {
                // console.log(collectionPromises)
                Promise.all(collectionPromises)
            })
    }

    server() {
        const app = express()
        app.use(bodyParser.urlencoded({ extended: true }));
        app.use(bodyParser.json());
        
        app.get('/', (req, res) => {
            res.send('I am groot');
        });

        app.post('/', (req, res) => {
            // console.log(req.params)
            // console.log(req.body)
            res.sendStatus(200);
            this.import()
        })

        app.listen(this.buildPort, () => {
            console.log(`Waiting for incoming webhook at ${this.buildHost}:${this.buildPort}`)
        });
    }
}

module.exports = Driver
