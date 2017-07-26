import { Type, PrimitiveType, FunctionType, TypeVariable, RecordType } from './types';
import { Value, StringValue, PredefinedFunction, RecordValue, ValueConstructor,
         ExceptionConstructor } from './values';
import { Token, LongIdentifierToken } from './lexer';
import { InternalInterpreterError } from './errors';

// maps id to [Value, rebindable, intermediate]
type DynamicValueEnvironment = { [name: string]: [Value, boolean] };
// maps id to [type (multiple if overloaded), intermediate]
type StaticValueEnvironment = { [name: string]: [Type[], boolean] };

export class TypeInformation {
    // Every constructor also appears in the value environment,
    // thus it suffices to record their names here.
    // To distinguish between redefined names, each type has its own id.
    constructor(public type: Type, public constructors: string[], id: number = 0) { }
}

// maps type name to constructor names
type DynamicTypeEnvironment = { [name: string]: [string[], number, boolean] };
// maps type name to (Type, constructor name)
type StaticTypeEnvironment = { [name: string]: [TypeInformation, boolean] };

export class TypeNameInformation {
    constructor(public arity: number,
                public allowsEquality: boolean,
                public isPrimitiveType: boolean = true) {
    }
}

// Maps type name to (arity, allows Equality)
type TypeNames = { [name: string]: TypeNameInformation };

export class InfixStatus {
    constructor(public infix: boolean,
                public precedence: number = 0,
                public rightAssociative: boolean = false) {}
}

type InfixEnvironment = { [name: string]: InfixStatus };

// Maps id to whether that id can be rebound
type RebindEnvironment = { [name: string]: boolean };

export class DynamicBasis {
    constructor(public typeEnvironment: DynamicTypeEnvironment,
                public valueEnvironment: DynamicValueEnvironment) {
    }

    getValue(name: string): [Value, boolean] | undefined {
        return this.valueEnvironment[name];
    }

    getType(name: string): [string[], number, boolean] | undefined {
        return this.typeEnvironment[name];
    }

    setValue(name: string, value: Value, intermediate: boolean): void {
        this.valueEnvironment[name] = [value, intermediate];
    }

    setType(name: string, type: string[], id: number = 0,
            intermediate: boolean = false) {
        this.typeEnvironment[name] = [type, id, intermediate];
    }
}

export class StaticBasis {
    constructor(public typeEnvironment: StaticTypeEnvironment,
                public valueEnvironment: StaticValueEnvironment) {
    }

    getValue(name: string): [Type[], boolean] | undefined {
        return this.valueEnvironment[name];
    }

    getType(name: string): [TypeInformation, boolean] | undefined {
        return this.typeEnvironment[name];
    }

    setValue(name: string, value: Type[], intermediate: boolean): void {
        this.valueEnvironment[name] = [value, intermediate];
    }

    setType(name: string, type: Type, constructors: string[], id: number = 0,
            intermediate: boolean = false) {
        this.typeEnvironment[name] = [new TypeInformation(type, constructors, id),
            intermediate];
    }
}

export class State {
    // The states' ids are non-decreasing; a single declaration uses the same ids
    constructor(public id: number,
                public parent: State | undefined,
                public staticBasis: StaticBasis,
                public dynamicBasis: DynamicBasis,
                private typeNames: TypeNames,
                private infixEnvironment: InfixEnvironment,
                private rebindEnvironment: RebindEnvironment,
                private declaredIdentifiers: Set<string> = new Set<string>(),
                private stdfiles: DynamicValueEnvironment = {
                    '__stdout': [new StringValue(''), true],
                    '__stdin':  [new StringValue(''), true],
                    '__stderr': [new StringValue(''), true]
                }) {
    }

    getDefinedIdentifiers(idLimit: number = 0): Set<string> {
        let rec = new Set<string>();
        if (this.parent !== undefined && this.parent.id >= idLimit) {
            rec = this.parent.getDefinedIdentifiers();
        }

        this.declaredIdentifiers.forEach((val: string) => {
            rec.add(val);
        });

        return rec;
    }

    getNestedState(redefinePrint: boolean = false, newId: number|undefined = undefined) {
        if (newId === undefined) {
            newId = this.id + 1;
        }
        let res = new State(<number> newId, this,
            new StaticBasis({}, {}),
            new DynamicBasis({}, {}),
            {}, {}, {});
        if (redefinePrint) {
            res.setDynamicValue('print', new PredefinedFunction('print', (val: Value) => {
                if (val instanceof StringValue) {
                    res.setDynamicValue('__stdout', val);
                } else {
                    res.setDynamicValue('__stdout', new StringValue(val.prettyPrint()));
                }
                return [new RecordValue(), false];
            }), true);
            res.setStaticValue('print', [new FunctionType(new TypeVariable('\'a'),
                new RecordType(new Map<string, Type>()))], true);
        }
        return res;
    }

    getRebindStatus(name: string): boolean {
        if ((this.rebindEnvironment[name] === undefined && this.parent === undefined)
            || this.rebindEnvironment[name]) {
            return true;
        } else if (this.rebindEnvironment[name] === undefined) {
            return (<State> this.parent).getRebindStatus(name);
        }
        return false;
    }

    // Gets an identifier's type. The value  intermediate  determines whether to return intermediate results
    getStaticValue(name: string, intermediate: boolean|undefined = undefined,
                   idLimit: number = 0): Type[] | undefined {
        if (this.stdfiles[name] !== undefined) {
            return [new PrimitiveType('string')];
        }
        let result = this.staticBasis.getValue(name);
        if ((result !== undefined && (intermediate === undefined || intermediate === result[1]))
            || !this.parent || this.parent.id < idLimit) {
            if (result === undefined) {
                return undefined;
            }
            return (<[Type[], boolean]> result)[0];
        } else {
            return this.parent.getStaticValue(name, intermediate, idLimit);
        }
    }

    getStaticType(name: string, intermediate: boolean|undefined = undefined,
                  idLimit: number = 0): TypeInformation | undefined {
        let result = this.staticBasis.getType(name);
        if ((result !== undefined && (intermediate === undefined || intermediate === result[1]))
            || !this.parent || this.parent.id < idLimit) {
            if (result === undefined) {
                return undefined;
            }
            return (<[TypeInformation, boolean]> result)[0];
        } else {
            return this.parent.getStaticType(name, intermediate, idLimit);
        }
    }

    getDynamicValue(name: string, intermediate: boolean|undefined = undefined,
                    idLimit: number = 0): Value | undefined {
        if (this.stdfiles[name] !== undefined
            && (<StringValue> this.stdfiles[name][0]).value !== '') {
            return this.stdfiles[name][0];
        }
        let result = this.dynamicBasis.getValue(name);
        if ((result !== undefined && (intermediate === undefined || intermediate === result[1]))
            || !this.parent || this.parent.id < idLimit) {
            if (result === undefined) {
                return undefined;
            }
            return (<[Value, boolean]> result)[0];
        } else {
            return this.parent.getDynamicValue(name, intermediate, idLimit);
        }
    }

    getDynamicType(name: string, intermediate: boolean|undefined = undefined,
                   idLimit: number = 0): [string[], number] | undefined {
        let result = this.dynamicBasis.getType(name);
        if ((result !== undefined && (intermediate === undefined || intermediate === result[2]))
            || !this.parent || this.parent.id < idLimit) {
            if (result === undefined) {
                return undefined;
            }
            return [(<[string[], number, boolean]> result)[0],
                (<[string[], number, boolean]> result)[1]];
        } else {
            return this.parent.getDynamicType(name, intermediate, idLimit);
        }
    }

    getInfixStatus(id: Token, idLimit: number = 0): InfixStatus {
        if (id.isVid() || id instanceof LongIdentifierToken ) {
            if (this.infixEnvironment.hasOwnProperty(id.getText()) || !this.parent
                || this.parent.id < idLimit) {
                return this.infixEnvironment[id.getText()];
            } else {
                return this.parent.getInfixStatus(id, idLimit);
            }
        } else {
            throw new InternalInterpreterError(id.position,
                'You gave me some "' + id.getText() + '" (' + id.constructor.name
                + ') but I only want (Long)IdentifierToken.');
        }
    }

    getPrimitiveType(name: string, idLimit: number = 0): TypeNameInformation {
        if (this.typeNames.hasOwnProperty(name) || !this.parent || this.parent.id < idLimit) {
            return this.typeNames[name];
        } else {
            return this.parent.getPrimitiveType(name, idLimit);
        }
    }

    setStaticValue(name: string, type: Type[], intermediate: boolean = false, atId: number|undefined = undefined) {
        if (this.stdfiles[name] !== undefined) {
            return;
        }
        if (atId === undefined || atId === this.id) {
            this.staticBasis.setValue(name, type, intermediate);
        } else if (atId > this.id || this.parent === undefined) {
            throw new InternalInterpreterError(-1, 'State with id "' + atId + '" does not exist.');
        } else {
            (<State> this.parent).setStaticValue(name, type, intermediate, atId);
        }
    }

    setStaticType(name: string, type: Type,
                  constructors: string[],
                  id: number = 0,
                  intermediate: boolean = false,
                  atId: number|undefined = undefined) {
        if (atId === undefined || atId === this.id) {
            this.staticBasis.setType(name, type, constructors, id, intermediate);
        } else if (atId > this.id || this.parent === undefined) {
            throw new InternalInterpreterError(-1, 'State with id "' + atId + '" does not exist.');
        } else {
            (<State> this.parent).setStaticType(name, type, constructors, id,
                intermediate, atId);
        }
    }

    setDynamicValue(name: string, value: Value, intermediate: boolean = false, atId: number|undefined = undefined) {
        if (atId === undefined || atId === this.id) {
            if (this.stdfiles[name] !== undefined) {
                if (value instanceof StringValue) {
                    this.stdfiles[name] = [(<StringValue> this.stdfiles[name][0]).concat(value), true];
                    return;
                } else {
                    throw new InternalInterpreterError(-1, 'Wrong type.');
                }
            }
            this.dynamicBasis.setValue(name, value, intermediate);
            this.declaredIdentifiers.add(name);
            if (value instanceof ValueConstructor || value instanceof ExceptionConstructor) {
                this.rebindEnvironment[name] = false;
            } else {
                this.rebindEnvironment[name] = true;
            }
        } else if (atId > this.id || this.parent === undefined) {
            throw new InternalInterpreterError(-1, 'State with id "' + atId + '" does not exist.');
        } else {
            this.parent.setDynamicValue(name, value, intermediate, atId);
        }
    }

    setDynamicType(name: string,
                   constructors: string[],
                   id: number = 0,
                   intermediate: boolean = false,
                   atId: number|undefined = undefined) {
        if (atId === undefined || atId === this.id) {
            this.dynamicBasis.setType(name, constructors, id, intermediate);
            this.declaredIdentifiers.add(name);
        } else if (atId > this.id || this.parent === undefined) {
            throw new InternalInterpreterError(-1, 'State with id "' + atId + '" does not exist.');
        } else {
            this.parent.setDynamicType(name, constructors, id, intermediate, atId);
        }
    }


    setInfixStatus(id: Token, precedence: number,
                   rightAssociative: boolean,
                   infix: boolean,
                   atId: number|undefined = undefined): void {
        if (atId === undefined || atId === this.id) {
            if (id.isVid() || id instanceof LongIdentifierToken) {
                this.infixEnvironment[id.getText()]
                    = new InfixStatus(infix, precedence, rightAssociative);
            }
        } else if (atId > this.id || this.parent === undefined) {
            throw new InternalInterpreterError(-1, 'State with id "' + atId + '" does not exist.');
        } else {
            this.parent.setInfixStatus(id, precedence, rightAssociative, infix, atId);
        }
    }
}
